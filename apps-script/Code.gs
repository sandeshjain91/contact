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
    case 'addContact':   return handleAddContact(data);
    default:             return jsonResponse({ error: 'Unknown action' });
  }
}

// ── Admin: status ─────────────────────────────────────────────────────────────

function handleGetStatus(data) {
  if (!checkPassword(data.password)) return jsonResponse({ error: 'Invalid password' });

  return jsonResponse({
    organization: PROPS.getProperty('organization') || '',
    label:        PROPS.getProperty('label')        || '',
  });
}

// ── Admin: update config ──────────────────────────────────────────────────────

function handleUpdateConfig(data) {
  if (!checkPassword(data.password)) return jsonResponse({ error: 'Invalid password' });

  const newLabel = (data.label || '').trim();
  const oldLabel = PROPS.getProperty('label') || '';

  PROPS.setProperty('organization', (data.organization || '').trim());
  PROPS.setProperty('label', newLabel);

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
  if (notes && String(notes).trim()) {
    contactBody.biographies = [{ value: String(notes).trim(), contentType: 'TEXT_PLAIN' }];
  }

  try {
    // Create contact via People API advanced service
    const created = People.People.createContact(contactBody);

    // Add to label/group if configured
    if (label) {
      try {
        const groupResourceName = getOrCreateGroup(label);
        if (groupResourceName) {
          People.ContactGroups.Members.modify(
            groupResourceName,
            { resourceNamesToAdd: [created.resourceName] }
          );
        }
      } catch (groupErr) {
        Logger.log('Group add failed (non-fatal): ' + groupErr.message);
      }
    }

    return jsonResponse({ success: true, message: 'Contact saved!' });
  } catch (err) {
    Logger.log('Error creating contact: ' + err.message);
    return jsonResponse({ error: 'Failed to save contact. Please try again.' });
  }
}

// ── Contact group helper (with caching) ───────────────────────────────────────

function getOrCreateGroup(groupName) {
  // Return cached resource name if the label hasn't changed
  const cachedLabel        = PROPS.getProperty('cachedGroupLabel');
  const cachedResourceName = PROPS.getProperty('cachedGroupResourceName');
  if (cachedLabel === groupName && cachedResourceName) {
    return cachedResourceName;
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
