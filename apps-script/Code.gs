// ════════════════════════════════════════════════════════════════════════════
// Contact Collector — Google Apps Script Backend
//
// DEPLOY SETTINGS (Apps Script → Deploy → New Deployment → Web app):
//   Execute as:     Me (your Google account)
//   Who has access: Anyone
//
// BEFORE DEPLOYING:
//   1. Project Settings → Script Properties → Add property:
//      ADMIN_PASSWORD = <choose a password>
//   2. Editor left sidebar → Services (+) → Add "Google People API"
// ════════════════════════════════════════════════════════════════════════════

const PROPS = PropertiesService.getScriptProperties();

// ── Routing ───────────────────────────────────────────────────────────────────

function doGet(e) {
  const action = (e.parameter && e.parameter.action) || '';

  if (action === 'getConfig') {
    return jsonResponse({
      organization: PROPS.getProperty('organization') || '',
      label:        PROPS.getProperty('label')        || '',
      theme:        PROPS.getProperty('theme')        || 'purple',
    });
  }

  return jsonResponse({ error: 'Unknown action' });
}

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (_) {
    return jsonResponse({ error: 'Invalid request body' });
  }

  switch (data.action) {
    case 'getStatus':    return handleGetStatus(data);
    case 'updateConfig': return handleUpdateConfig(data);
    case 'addContact':      return handleAddContact(data);
    case 'addBulkContacts': return handleBulkContacts(data);
    default:                return jsonResponse({ error: 'Unknown action' });
  }
}

// ── Admin: status ─────────────────────────────────────────────────────────────

function handleGetStatus(data) {
  if (!checkPassword(data.password)) return jsonResponse({ error: 'Invalid password' });

  return jsonResponse({
    organization: PROPS.getProperty('organization') || '',
    label:        PROPS.getProperty('label')        || '',
    theme:        PROPS.getProperty('theme')        || 'purple',
  });
}

// ── Admin: update config ──────────────────────────────────────────────────────

function handleUpdateConfig(data) {
  if (!checkPassword(data.password)) return jsonResponse({ error: 'Invalid password' });

  const newLabel = (data.label || '').trim();
  const oldLabel = PROPS.getProperty('label') || '';

  PROPS.setProperty('organization', (data.organization || '').trim());
  PROPS.setProperty('label', newLabel);
  PROPS.setProperty('theme', (data.theme || 'purple').trim());

  // Invalidate cached group resource name if label changed
  if (newLabel !== oldLabel) {
    PROPS.deleteProperty('cachedGroupResourceName');
    PROPS.deleteProperty('cachedGroupLabel');
  }

  return jsonResponse({ success: true });
}

// ── Contact creation ──────────────────────────────────────────────────────────

function handleAddContact(data) {
  const { firstName, lastName, email, phone, jobTitle, notes } = data;

  if (!String(firstName || '').trim() && !String(lastName || '').trim()) {
    return jsonResponse({ error: 'Please enter at least a first or last name.' });
  }

  const organization = PROPS.getProperty('organization') || '';
  const label        = PROPS.getProperty('label')        || '';

  // Build People API contact payload
  const contactBody = {
    names: [{
      givenName:  String(firstName || '').trim(),
      familyName: String(lastName  || '').trim(),
    }],
  };

  if (email && String(email).trim()) {
    contactBody.emailAddresses = [{ value: String(email).trim(), type: 'work' }];
  }
  if (phone && String(phone).trim()) {
    contactBody.phoneNumbers = [{ value: String(phone).trim(), type: 'mobile' }];
  }
  if (organization) {
    contactBody.organizations = [{
      name:  organization,
      title: String(jobTitle || '').trim(),
      type:  'work',
    }];
  } else if (jobTitle && String(jobTitle).trim()) {
    contactBody.organizations = [{ title: String(jobTitle).trim(), type: 'work' }];
  }
  // Build note with timestamp prepended
  const timestamp = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    'dd MMM yyyy, hh:mm a z'
  );
  const userNotes   = String(notes || '').trim();
  const noteContent = userNotes
    ? `Submitted via contact form on: ${timestamp}\n\n${userNotes}`
    : `Submitted via contact form on: ${timestamp}`;
  contactBody.biographies = [{ value: noteContent, contentType: 'TEXT_PLAIN' }];

  // Include group membership in the contact payload at creation time
  if (label) {
    try {
      const groupResourceName = getOrCreateGroup(label);
      if (groupResourceName) {
        contactBody.memberships = [{
          contactGroupMembership: { contactGroupResourceName: groupResourceName }
        }];
        Logger.log('Adding to group: ' + groupResourceName);
      }
    } catch (groupErr) {
      Logger.log('Group lookup failed (non-fatal): ' + groupErr.message);
    }
  }

  try {
    People.People.createContact(contactBody);
    return jsonResponse({ success: true, message: 'Contact saved!' });
  } catch (err) {
    Logger.log('Error creating contact: ' + err.message);
    return jsonResponse({ error: 'Failed to save contact. Please try again.' });
  }
}

// ── Bulk contact creation from CSV ───────────────────────────────────────────

function handleBulkContacts(data) {
  if (!checkPassword(data.password)) return jsonResponse({ error: 'Invalid password' });

  const contacts = data.contacts || [];
  if (!contacts.length) return jsonResponse({ saved: 0, failed: 0 });

  const organization = PROPS.getProperty('organization') || '';
  const label        = PROPS.getProperty('label')        || '';

  const timestamp = Utilities.formatDate(
    new Date(), Session.getScriptTimeZone(), 'dd MMM yyyy, hh:mm a z'
  );
  const noteContent = 'Imported via CSV on: ' + timestamp;

  // Resolve group once for the whole batch
  let groupResourceName = null;
  if (label) {
    try { groupResourceName = getOrCreateGroup(label); } catch (e) { Logger.log('Group lookup: ' + e.message); }
  }

  let saved = 0, failed = 0;

  contacts.forEach(c => {
    const firstName = String(c.firstName || c.name || '').trim();
    const lastName  = String(c.lastName  || '').trim();

    if (!firstName && !lastName && !c.number) { failed++; return; }

    const body = {
      names: [{ givenName: firstName, familyName: lastName }],
      biographies: [{ value: noteContent, contentType: 'TEXT_PLAIN' }],
    };

    if (c.number) body.phoneNumbers = [{ value: String(c.number).trim(), type: 'mobile' }];

    // Company: row-level overrides org setting; fall back to org setting
    const company  = String(c.company  || '').trim() || organization;
    const jobTitle = String(c.jobTitle || '').trim();
    if (company || jobTitle) {
      body.organizations = [{ name: company, title: jobTitle, type: 'work' }];
    }

    if (groupResourceName) {
      body.memberships = [{ contactGroupMembership: { contactGroupResourceName: groupResourceName } }];
    }

    try {
      People.People.createContact(body);
      saved++;
    } catch (e) {
      Logger.log('Bulk create failed for ' + c.name + ': ' + e.message);
      failed++;
    }
  });

  return jsonResponse({ saved, failed });
}

// ── Contact group helper (with caching) ───────────────────────────────────────

function getOrCreateGroup(groupName) {
  // Return cached resource name if the label hasn't changed — but verify it still exists
  const cachedLabel        = PROPS.getProperty('cachedGroupLabel');
  const cachedResourceName = PROPS.getProperty('cachedGroupResourceName');
  if (cachedLabel === groupName && cachedResourceName) {
    try {
      People.ContactGroups.get(cachedResourceName);
      return cachedResourceName; // still valid
    } catch (_) {
      // Stale cache — clear it and fall through to fresh lookup
      Logger.log('Cached group not found, refreshing...');
      PROPS.deleteProperty('cachedGroupLabel');
      PROPS.deleteProperty('cachedGroupResourceName');
    }
  }

  // Fetch all user-created contact groups
  let resourceName = null;
  try {
    const resp   = People.ContactGroups.list({ pageSize: 200 });
    const groups = (resp.contactGroups || []).filter(g => g.groupType === 'USER_CONTACT_GROUP');
    const found  = groups.find(g => g.name === groupName);
    if (found) {
      resourceName = found.resourceName;
    }
  } catch (e) {
    Logger.log('Error listing groups: ' + e.message);
  }

  // Create the group if it doesn't exist yet
  if (!resourceName) {
    try {
      const created = People.ContactGroups.create({ contactGroup: { name: groupName } });
      resourceName  = created.resourceName;
    } catch (e) {
      // Handle race condition: two simultaneous submissions may both try to create the group.
      // Fall back to listing again.
      Logger.log('Group creation failed, retrying list: ' + e.message);
      const resp2   = People.ContactGroups.list({ pageSize: 200 });
      const groups2 = (resp2.contactGroups || []).filter(g => g.groupType === 'USER_CONTACT_GROUP');
      const found2  = groups2.find(g => g.name === groupName);
      if (found2) resourceName = found2.resourceName;
    }
  }

  // Cache the result
  if (resourceName) {
    PROPS.setProperty('cachedGroupLabel', groupName);
    PROPS.setProperty('cachedGroupResourceName', resourceName);
  }

  return resourceName;
}

// ── Debug: run this manually from the editor to test group assignment ─────────

function testLabelAssignment() {
  const label = PROPS.getProperty('label');
  Logger.log('Label from settings: ' + label);

  // Clear stale cache
  PROPS.deleteProperty('cachedGroupLabel');
  PROPS.deleteProperty('cachedGroupResourceName');

  const groupResourceName = getOrCreateGroup(label);
  Logger.log('Group resourceName: ' + groupResourceName);

  // Create test contact with group membership included at creation time
  const contact = People.People.createContact({
    names: [{ givenName: 'TEST', familyName: 'DELETE_ME' }],
    memberships: [{
      contactGroupMembership: { contactGroupResourceName: groupResourceName }
    }]
  });
  Logger.log('Done — contact: ' + contact.resourceName);
  Logger.log('Check Google Contacts for TEST DELETE_ME under label: ' + label);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function checkPassword(provided) {
  const stored = PROPS.getProperty('ADMIN_PASSWORD');
  if (!stored) {
    Logger.log('ADMIN_PASSWORD not set in Script Properties!');
    return false;
  }
  return provided === stored;
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
