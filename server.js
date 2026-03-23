require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CONFIG_FILE = path.join(__dirname, 'config.json');

// ── Config helpers ────────────────────────────────────────────────────────────

function readConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch { /* fall through */ }
  }
  return { organization: '', label: '', tokens: null };
}

function writeConfig(data) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

// ── OAuth client ──────────────────────────────────────────────────────────────

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback'
);

// Restore saved tokens on startup
const savedConfig = readConfig();
if (savedConfig.tokens) {
  oauth2Client.setCredentials(savedConfig.tokens);
}

// Auto-save refreshed tokens
oauth2Client.on('tokens', (tokens) => {
  const cfg = readConfig();
  cfg.tokens = { ...cfg.tokens, ...tokens };
  writeConfig(cfg);
});

// ── Auth routes ───────────────────────────────────────────────────────────────

app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/contacts'],
    prompt: 'consent',
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect('/admin.html?auth=error&msg=' + encodeURIComponent(error));
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const cfg = readConfig();
    cfg.tokens = tokens;
    writeConfig(cfg);

    res.redirect('/admin.html?auth=success');
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect('/admin.html?auth=error&msg=' + encodeURIComponent(err.message));
  }
});

// ── Admin API ─────────────────────────────────────────────────────────────────

function checkAdmin(req, res) {
  const { password } = req.body;
  if (!process.env.ADMIN_PASSWORD) {
    res.status(500).json({ error: 'ADMIN_PASSWORD not set in .env' });
    return false;
  }
  if (password !== process.env.ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Invalid password' });
    return false;
  }
  return true;
}

// Get current public config (org/label names, no sensitive data)
app.get('/api/config/public', (req, res) => {
  const cfg = readConfig();
  res.json({
    organization: cfg.organization || '',
    label: cfg.label || '',
  });
});

// Get full config status (requires password in query for simplicity on page load)
app.post('/api/config/status', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const cfg = readConfig();
  res.json({
    organization: cfg.organization || '',
    label: cfg.label || '',
    hasAuth: !!(cfg.tokens && (cfg.tokens.refresh_token || cfg.tokens.access_token)),
  });
});

// Update organization and label
app.post('/api/config/update', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { organization, label } = req.body;

  const cfg = readConfig();
  cfg.organization = (organization || '').trim();
  cfg.label = (label || '').trim();
  writeConfig(cfg);

  res.json({ success: true, organization: cfg.organization, label: cfg.label });
});

// Revoke auth
app.post('/api/config/revoke', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const cfg = readConfig();
    if (cfg.tokens?.access_token) {
      await oauth2Client.revokeToken(cfg.tokens.access_token).catch(() => {});
    }
    cfg.tokens = null;
    writeConfig(cfg);
    oauth2Client.setCredentials({});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Contact group helper ──────────────────────────────────────────────────────

async function getOrCreateGroup(peopleApi, groupName) {
  const listResp = await peopleApi.contactGroups.list({ pageSize: 200 });
  const groups = listResp.data.contactGroups || [];
  const existing = groups.find(
    (g) => g.groupType === 'USER_CONTACT_GROUP' && g.name === groupName
  );
  if (existing) return existing.resourceName;

  const createResp = await peopleApi.contactGroups.create({
    requestBody: { contactGroup: { name: groupName } },
  });
  return createResp.data.resourceName;
}

// ── Contact submission ────────────────────────────────────────────────────────

app.post('/api/contact', async (req, res) => {
  const { firstName, lastName, email, phone, jobTitle, notes } = req.body;

  if (!firstName && !lastName) {
    return res.status(400).json({ error: 'Please enter at least a first or last name.' });
  }

  const cfg = readConfig();

  if (!cfg.tokens) {
    return res.status(503).json({
      error: 'Google account not connected. Please ask the administrator to connect the account.',
    });
  }

  oauth2Client.setCredentials(cfg.tokens);

  const people = google.people({ version: 'v1', auth: oauth2Client });

  // Build contact payload
  const contactBody = {
    names: [{ givenName: (firstName || '').trim(), familyName: (lastName || '').trim() }],
  };

  if (email && email.trim()) {
    contactBody.emailAddresses = [{ value: email.trim(), type: 'work' }];
  }
  if (phone && phone.trim()) {
    contactBody.phoneNumbers = [{ value: phone.trim(), type: 'mobile' }];
  }
  if (cfg.organization) {
    contactBody.organizations = [{
      name: cfg.organization,
      title: (jobTitle || '').trim(),
      type: 'work',
    }];
  } else if (jobTitle && jobTitle.trim()) {
    contactBody.organizations = [{ title: jobTitle.trim(), type: 'work' }];
  }
  if (notes && notes.trim()) {
    contactBody.biographies = [{ value: notes.trim(), contentType: 'TEXT_PLAIN' }];
  }

  try {
    // Create the contact
    const created = await people.people.createContact({ requestBody: contactBody });
    const resourceName = created.data.resourceName;

    // Add to label/group if configured
    if (cfg.label) {
      try {
        const groupResourceName = await getOrCreateGroup(people, cfg.label);
        await people.contactGroups.members.modify({
          resourceName: groupResourceName,
          requestBody: { resourceNamesToAdd: [resourceName] },
        });
      } catch (groupErr) {
        // Non-fatal — contact was still created
        console.warn('Could not add contact to group:', groupErr.message);
      }
    }

    res.json({ success: true, message: 'Your contact details have been saved!' });
  } catch (err) {
    console.error('Error creating contact:', err.message);
    const msg = err.message?.includes('invalid_grant')
      ? 'Google authorization expired. Please ask the administrator to reconnect the account.'
      : 'Failed to save contact. Please try again.';
    res.status(500).json({ error: msg });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✓ Contact Collector running at http://localhost:${PORT}`);
  console.log(`  Form:  http://localhost:${PORT}/`);
  console.log(`  Admin: http://localhost:${PORT}/admin.html\n`);
});
