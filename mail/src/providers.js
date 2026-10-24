// Ajustes automáticos de IMAP/SMTP por proveedor, para que el usuario solo ponga correo y contraseña
const PROVIDERS = {
	gmail: { label: 'Gmail', imap: 'imap.gmail.com', smtp: 'smtp.gmail.com', help: 'Activa la verificación en dos pasos y crea una «Contraseña de aplicación» en myaccount.google.com/apppasswords.' },
	googlemail: { label: 'Gmail', imap: 'imap.gmail.com', smtp: 'smtp.gmail.com' },
	outlook: { label: 'Outlook', imap: 'outlook.office365.com', smtp: 'smtp.office365.com', smtpPort: 587, help: 'Crea una contraseña de aplicación en account.microsoft.com/security.' },
	hotmail: { label: 'Outlook', imap: 'outlook.office365.com', smtp: 'smtp.office365.com', smtpPort: 587 },
	live: { label: 'Outlook', imap: 'outlook.office365.com', smtp: 'smtp.office365.com', smtpPort: 587 },
	office365: { label: 'Microsoft 365', imap: 'outlook.office365.com', smtp: 'smtp.office365.com', smtpPort: 587 },
	yahoo: { label: 'Yahoo', imap: 'imap.mail.yahoo.com', smtp: 'smtp.mail.yahoo.com', help: 'Crea una contraseña de aplicación en los ajustes de seguridad de Yahoo.' },
	zoho: { label: 'Zoho', imap: 'imap.zoho.com', smtp: 'smtp.zoho.com', help: 'Usa tu contraseña normal, o una contraseña de aplicación si tienes verificación en dos pasos.' },
	icloud: { label: 'iCloud', imap: 'imap.mail.me.com', smtp: 'smtp.mail.me.com', smtpPort: 587, help: 'Crea una contraseña de aplicación en appleid.apple.com.' }
}

// Dominios conocidos que usan la infraestructura de otro proveedor
const DOMAIN_ALIASES = {
	'googlemail.com': 'gmail',
	'live.com': 'outlook', 'live.com.mx': 'outlook', 'msn.com': 'outlook',
	'ymail.com': 'yahoo', 'rocketmail.com': 'yahoo',
	'zoho.com': 'zoho', 'zohomail.com': 'zoho',
	'me.com': 'icloud', 'mac.com': 'icloud'
}

export function guessProvider(email) {
	const domain = String(email).toLowerCase().split('@')[1] || ''
	const base = domain.split('.')[0]
	const key = DOMAIN_ALIASES[domain] || (PROVIDERS[base] ? base : null)
	if (!key) return null
	const p = PROVIDERS[key]
	return {
		provider: p.label,
		imapHost: p.imap,
		imapPort: 993,
		smtpHost: p.smtp,
		smtpPort: p.smtpPort || 465,
		help: p.help || null
	}
}

/** Para dominios propios (como los de Zoho con GoDaddy), se intenta adivinar el servidor */
export function guessCustom(email) {
	const domain = String(email).toLowerCase().split('@')[1] || ''
	return {
		provider: 'Dominio propio',
		imapHost: `imap.${domain}`,
		imapPort: 993,
		smtpHost: `smtp.${domain}`,
		smtpPort: 465,
		help: 'Si no conecta, revisa en tu proveedor de correo cuál es su servidor IMAP y SMTP. Para Zoho usa imap.zoho.com y smtp.zoho.com.'
	}
}
