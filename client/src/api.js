async function request(path, options = {}) {
  let response;
  try { response = await fetch(`/api${path}`, options); }
  catch { throw new Error('Cannot reach the API. Check that the server and MongoDB are running.'); }
  const body = await response.json();
  if (!response.ok) {
    const details = body.error?.details?.join('; ');
    throw new Error([body.error?.message || `HTTP ${response.status}`, details].filter(Boolean).join(': '));
  }
  return body;
}

export const api = {
  workflows: () => request('/workflows'),
  requests: () => request('/requests'),
  getRequest: (id) => request(`/requests/${encodeURIComponent(id)}`),
  submit: (payload, key) => request('/requests', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(payload)
  }),
  retry: (id) => request(`/requests/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  review: (id, payload) => request(`/requests/${encodeURIComponent(id)}/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  })
};
