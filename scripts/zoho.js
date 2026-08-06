// Zoho CRM client: refresh-token OAuth + paged record pull. No dependencies (Node 20+).

const DC = process.env.ZOHO_DC || 'com';
const ACCOUNTS = `https://accounts.zoho.${DC}`;
const API = `https://www.zohoapis.${DC}/crm/v7`;

export async function accessToken() {
  const body = new URLSearchParams({
    refresh_token: required('ZOHO_REFRESH_TOKEN'),
    client_id: required('ZOHO_CLIENT_ID'),
    client_secret: required('ZOHO_CLIENT_SECRET'),
    grant_type: 'refresh_token'
  });
  const res = await fetch(`${ACCOUNTS}/oauth/v2/token`, { method: 'POST', body });
  const json = await res.json();
  if (!json.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(json));
  return json.access_token;
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

// Pull every record in a module, following v7 page_token pagination.
export async function fetchAll(token, module, fields) {
  const out = [];
  let pageToken = null;
  for (let guard = 0; guard < 200; guard++) {
    const qs = new URLSearchParams({ fields: fields.join(','), per_page: '200' });
    if (pageToken) qs.set('page_token', pageToken);
    const res = await fetch(`${API}/${module}?${qs}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    if (res.status === 204) break;
    if (res.status === 429) { await sleep(60000); continue; }
    if (!res.ok) throw new Error(`${module} fetch ${res.status}: ${await res.text()}`);
    const json = await res.json();
    out.push(...(json.data || []));
    const info = json.info || {};
    if (!info.more_records) break;
    pageToken = info.next_page_token;
    if (!pageToken) break;
    await sleep(250);
  }
  return out;
}

// Field API names for a module — run `npm run discover` to print these.
export async function fieldNames(token, module) {
  const res = await fetch(`${API}/settings/fields?module=${module}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` }
  });
  if (!res.ok) throw new Error(`fields ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return (json.fields || []).map(f => ({
    label: f.field_label, api: f.api_name, type: f.data_type
  }));
}

export function recordUrl(module, id) {
  const org = process.env.ZOHO_ORG_ID;
  const base = `https://crm.zoho.${DC}/crm`;
  return org ? `${base}/org${org}/tab/${module}/${id}` : `${base}/tab/${module}/${id}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
