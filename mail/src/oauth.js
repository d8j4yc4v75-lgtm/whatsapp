import crypto from 'node:crypto'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import { db, getSetting, setSetting } from './db.js'

// "Iniciar sesión con Google / Microsoft": el usuario conecta su cuenta con un clic.
// Leemos por IMAP (puerto 993, permitido) y ENVIAMOS por la API (puerto 443),
// así nunca tocamos SMTP, que la nube bloquea.

export const OAUTH = {
	google: {
		label: 'Google',
		authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		// mail.google.com cubre IMAP (XOAUTH2) y el envío por la API de Gmail
		scope: 'https://mail.google.com/',
		authExtra: { access_type: 'offline', prompt: 'consent' },
		imapHost: 'imap.gmail.com'
	},
	microsoft: {
		label: 'Microsoft',
		authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
		tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
		scope: 'offline_access openid email https://outlook.office.com/IMAP.AccessAsUser.All https://graph.microsoft.com/Mail.Send',
		authExtra: { prompt: 'consent' },
		imapHost: 'outlook.office365.com'
	}
}

const keyId = p => `${p}_client_id`
const keySecret = p => `${p}_client_secret`

export function oauthConfigured(p) { return Boolean(clientId(p) && clientSecret(p)) }
export function clientId(p) { return getSetting(keyId(p)) || process.env[`${p.toUpperCase()}_CLIENT_ID`] || null }
export function clientSecret(p) { return getSetting(keySecret(p)) || process.env[`${p.toUpperCase()}_CLIENT_SECRET`] || null }
export function saveClient(p, id, secret) { setSetting(keyId(p), id?.trim() || null); setSetting(keySecret(p), secret?.trim() || null) }

// --- Flujo de autorización ---
const pending = new Map() // state -> { provider, redirectUri, at }
setInterval(() => { const cut = Date.now() - 6e5; for (const [k, v] of pending) if (v.at < cut) pending.delete(k) }, 6e5).unref?.()

export function startAuth(provider, redirectUri) {
	const cfg = OAUTH[provider]
	if (!cfg) throw new Error('Proveedor no válido')
	if (!oauthConfigured(provider)) throw new Error(`Falta configurar la app de ${cfg.label}`)
	const state = crypto.randomBytes(16).toString('hex')
	pending.set(state, { provider, redirectUri, at: Date.now() })
	const params = new URLSearchParams({
		client_id: clientId(provider),
		redirect_uri: redirectUri,
		response_type: 'code',
		scope: cfg.scope,
		state,
		include_granted_scopes: 'true',
		...cfg.authExtra
	})
	return `${cfg.authUrl}?${params}`
}

async function tokenRequest(provider, body) {
	const cfg = OAUTH[provider]
	const res = await fetch(cfg.tokenUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ client_id: clientId(provider), client_secret: clientSecret(provider), ...body }),
		signal: AbortSignal.timeout(20000)
	})
	const data = await res.json().catch(() => ({}))
	if (!res.ok) throw new Error(data.error_description || data.error || `Error ${res.status} al autenticar`)
	return data
}

// Intercambia el "code" por tokens y devuelve { email, refresh_token }
export async function finishAuth(state, code) {
	const p = pending.get(state)
	if (!p) throw new Error('La sesión de conexión expiró, inténtalo de nuevo')
	pending.delete(state)
	const { provider, redirectUri } = p
	const tok = await tokenRequest(provider, { grant_type: 'authorization_code', code, redirect_uri: redirectUri })
	if (!tok.refresh_token) throw new Error('Google/Microsoft no devolvió permiso permanente. Revoca el acceso y vuelve a intentar.')
	const access = tok.access_token
	const email = await fetchEmail(provider, access)
	if (!email) throw new Error('No se pudo leer el correo de la cuenta')
	return { provider, email, refresh_token: tok.refresh_token, access_token: access, expires_in: tok.expires_in || 3600 }
}

async function fetchEmail(provider, accessToken) {
	if (provider === 'google') {
		const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) })
		return (await r.json().catch(() => ({}))).emailAddress || null
	}
	const r = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) })
	const d = await r.json().catch(() => ({}))
	return d.mail || d.userPrincipalName || null
}

// --- Tokens de acceso para enviar/leer (se refrescan solos) ---
async function refresh(provider, refreshToken, scope) {
	return tokenRequest(provider, { grant_type: 'refresh_token', refresh_token: refreshToken, ...(scope ? { scope } : {}) })
}

// Token para IMAP (lectura). Se guarda en la cuenta y se reutiliza hasta que caduca.
export async function imapAccessToken(account) {
	if (account.access_token && account.token_expiry && account.token_expiry > Date.now() + 60000) return account.access_token
	const scope = account.provider_type === 'microsoft' ? 'offline_access https://outlook.office.com/IMAP.AccessAsUser.All' : undefined
	const tok = await refresh(account.provider_type, account.refresh_token, scope)
	const access = tok.access_token
	const expiry = Date.now() + (tok.expires_in || 3600) * 1000
	db.prepare('UPDATE accounts SET access_token = ?, token_expiry = ?' + (tok.refresh_token ? ', refresh_token = ?' : '') + ' WHERE id = ?')
		.run(...(tok.refresh_token ? [access, expiry, tok.refresh_token, account.id] : [access, expiry, account.id]))
	return access
}

// --- Envío por API (sin SMTP) ---
export async function apiSend(account, mail) {
	if (account.provider_type === 'google') return sendGmail(account, mail)
	if (account.provider_type === 'microsoft') return sendGraph(account, mail)
	throw new Error('Cuenta sin envío por API')
}

function buildMime(account, mail) {
	const headers = {}
	if (mail.bulk) headers['List-Unsubscribe'] = `<mailto:${account.email}?subject=BAJA>`
	return new Promise((resolve, reject) => {
		new MailComposer({
			from: { name: account.name, address: account.email },
			to: mail.to, cc: mail.cc || undefined, subject: mail.subject,
			text: mail.text, html: mail.html || undefined,
			inReplyTo: mail.inReplyTo || undefined, references: mail.references || undefined,
			attachments: mail.attachments || undefined,
			headers
		}).compile().build((err, msg) => err ? reject(err) : resolve(msg))
	})
}

async function sendGmail(account, mail) {
	const token = await imapAccessToken(account) // mail.google.com sirve también para la API de Gmail
	const mime = await buildMime(account, mail)
	const raw = mime.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
	const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ raw }),
		signal: AbortSignal.timeout(25000)
	})
	const d = await r.json().catch(() => ({}))
	if (!r.ok) throw new Error(d.error?.message || `Gmail API ${r.status}`)
	return d.id || null
}

async function graphToken(account) {
	const tok = await refresh('microsoft', account.refresh_token, 'offline_access https://graph.microsoft.com/Mail.Send')
	if (tok.refresh_token) db.prepare('UPDATE accounts SET refresh_token = ? WHERE id = ?').run(tok.refresh_token, account.id)
	return tok.access_token
}

async function sendGraph(account, mail) {
	const token = await graphToken(account)
	const toList = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(s => s.trim()).filter(Boolean).map(a => ({ emailAddress: { address: a } }))
	const message = {
		subject: mail.subject || '',
		body: { contentType: mail.html ? 'HTML' : 'Text', content: mail.html || mail.text || ' ' },
		toRecipients: toList(mail.to),
		ccRecipients: toList(mail.cc)
	}
	if (mail.attachments?.length) {
		message.attachments = mail.attachments.map(at => ({
			'@odata.type': '#microsoft.graph.fileAttachment',
			name: at.filename || at.name || 'adjunto',
			contentBytes: (Buffer.isBuffer(at.content) ? at.content : Buffer.from(at.content || '')).toString('base64')
		}))
	}
	const r = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ message, saveToSentItems: true }),
		signal: AbortSignal.timeout(25000)
	})
	if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error?.message || `Graph ${r.status}`) }
	return null
}
