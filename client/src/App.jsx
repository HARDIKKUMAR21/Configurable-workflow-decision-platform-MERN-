import { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

const newKey = () => crypto.randomUUID();
const date = (value) => value ? new Date(value).toLocaleString() : '—';

function Status({ value }) {
  return <span className={`status status-${value?.toLowerCase().replaceAll('_', '-')}`}>{value?.replaceAll('_', ' ')}</span>;
}

function Audit({ request }) {
  const events = [...(request?.audit || [])].reverse();
  return <div className="timeline">
    {events.map((event, index) => <div className="event" key={`${event.at}-${index}`}>
      <div className="event-mark" />
      <div className="event-content">
        <div className="event-head"><strong>{event.type?.replaceAll('_', ' ')}</strong><time>{date(event.at)}</time></div>
        <div className="event-meta">
          {event.stageId && <span>Stage: {event.stageId}</span>}
          {event.ruleId && <span>Rule: {event.ruleId}</span>}
          {event.result && <span>Result: {event.result}</span>}
          {event.outcome && <span>Outcome: {event.outcome}</span>}
        </div>
        {event.type === 'RULE_EVALUATED' && event.result !== 'SKIPPED' &&
          <p>{event.dataRef}: <b>{JSON.stringify(event.actual)}</b> {event.operator} {JSON.stringify(event.expected)}{event.reason ? ` · ${event.reason}` : ''}</p>}
        {event.type === 'RULE_EVALUATED' && event.result === 'SKIPPED' && <p>Condition did not apply: {event.condition?.field} {event.condition?.op} {JSON.stringify(event.condition?.value)}</p>}
        {event.type === 'DEPENDENCY_RESULT' && <p>Risk score: <b>{event.output?.riskScore}</b> · Operation key: {event.operationKey}</p>}
        {event.message && <p>{event.message}</p>}
        {event.reason && ['DECISION_RECORDED', 'MANUAL_REVIEW_RESOLVED'].includes(event.type) && <p>{event.reason}</p>}
      </div>
    </div>)}
  </div>;
}

export default function App() {
  const [workflows, setWorkflows] = useState([]);
  const [selectedKey, setSelectedKey] = useState('');
  const [inputText, setInputText] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [requests, setRequests] = useState([]);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [operator, setOperator] = useState('demo-operator');
  const workflow = useMemo(() => workflows.find((item) => `${item.id}@${item.version}` === selectedKey), [workflows, selectedKey]);

  async function refresh(selectedId) {
    const rows = await api.requests();
    setRequests(rows);
    if (selectedId) setSelectedRequest(await api.getRequest(selectedId));
  }

  useEffect(() => {
    Promise.all([api.workflows(), api.requests()]).then(([definitions, rows]) => {
      setWorkflows(definitions);
      setRequests(rows);
      if (definitions.length) {
        const first = definitions[0];
        setSelectedKey(`${first.id}@${first.version}`);
        setInputText(JSON.stringify(first.exampleInput, null, 2));
      }
    }).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!selectedRequest || !['RETRY_PENDING', 'PROCESSING'].includes(selectedRequest.status)) return;
    const timer = setInterval(() => refresh(selectedRequest.id).catch((err) => setError(err.message)), 2000);
    return () => clearInterval(timer);
  }, [selectedRequest?.id, selectedRequest?.status]);

  function chooseWorkflow(key) {
    setSelectedKey(key);
    const definition = workflows.find((item) => `${item.id}@${item.version}` === key);
    setInputText(JSON.stringify(definition.exampleInput, null, 2));
    setError('');
  }

  async function submit(event) {
    event.preventDefault();
    setError(''); setNotice(''); setBusy(true);
    try {
      const input = JSON.parse(inputText);
      const result = await api.submit({ workflowId: workflow.id, version: workflow.version, input }, idempotencyKey);
      setSelectedRequest(result.request);
      setNotice(result.duplicate ? 'Existing request returned for this idempotency key.' : 'Request processed and audited.');
      await refresh(result.request.id);
    } catch (err) { setError(err instanceof SyntaxError ? 'Input must be valid JSON.' : err.message); }
    finally { setBusy(false); }
  }

  async function selectRequest(id) {
    setError('');
    try { setSelectedRequest(await api.getRequest(id)); }
    catch (err) { setError(err.message); }
  }

  async function retry() {
    setError(''); setBusy(true);
    try {
      const request = await api.retry(selectedRequest.id);
      setSelectedRequest(request);
      setNotice('Retry attempted.');
      await refresh(request.id);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function resolveReview(decision) {
    setError(''); setBusy(true);
    try {
      const request = await api.review(selectedRequest.id, { decision, operator, note: reviewNote });
      setSelectedRequest(request);
      setReviewNote('');
      setNotice('Manual review recorded.');
      await refresh(request.id);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return <div className="shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">◆</span><span>DECISION / SYSTEM</span></div><span className="topbar-note">Configurable workflow console</span></header>
    <main>
      <section className="hero"><div><p className="eyebrow">OPERATIONS CONSOLE / 01</p><h1>Decisions you can<br /><em>trace.</em></h1><p className="hero-copy">Submit a request, follow every rule, and see exactly why the workflow reached its outcome.</p></div><div className="hero-stat"><span>{workflows.length.toString().padStart(2, '0')}</span><small>AVAILABLE WORKFLOW<br />VERSIONS</small></div></section>
      {(error || notice) && <div className={`banner ${error ? 'banner-error' : ''}`}>{error || notice}</div>}
      <div className="grid">
        <section className="panel form-panel"><div className="panel-heading"><span className="step">01</span><div><p className="eyebrow">NEW REQUEST</p><h2>Evaluate a workflow</h2></div></div>
          <form onSubmit={submit}>
            <label>Workflow version<select value={selectedKey} onChange={(event) => chooseWorkflow(event.target.value)}>{workflows.map((item) => <option key={`${item.id}@${item.version}`} value={`${item.id}@${item.version}`}>{item.name} · v{item.version}</option>)}</select></label>
            {workflow && <p className="field-hint">{workflow.description}</p>}
            <label>Input payload <span className="field-hint">JSON</span><textarea spellCheck="false" value={inputText} onChange={(event) => setInputText(event.target.value)} rows="11" /></label>
            <label>Idempotency key<input value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} /></label>
            <div className="form-actions"><button type="button" className="text-button" onClick={() => setIdempotencyKey(newKey())}>Generate new key ↗</button><button className="primary" disabled={busy || !workflow}>Run decision <span>→</span></button></div>
          </form>
        </section>
        <section className="panel recent-panel"><div className="panel-heading"><span className="step">02</span><div><p className="eyebrow">REQUESTS</p><h2>Recent activity</h2></div><button className="icon-button" onClick={() => refresh(selectedRequest?.id).catch((err) => setError(err.message))} aria-label="Refresh requests">↻</button></div>
          <div className="request-list">{requests.length ? requests.map((item) => <button className={`request-item ${selectedRequest?.id === item.id ? 'active' : ''}`} key={item.id} onClick={() => selectRequest(item.id)}><span><strong>{item.workflowId}</strong><small>{item.id.slice(0, 8)} · {date(item.createdAt)}</small></span><Status value={item.status} /></button>) : <p className="empty">No requests yet. Submit one to see its decision trail.</p>}</div>
        </section>
      </div>
      <section className="panel detail-panel"><div className="panel-heading"><span className="step">03</span><div><p className="eyebrow">EXPLAINABILITY</p><h2>Decision detail</h2></div>{selectedRequest && <Status value={selectedRequest.status} />}</div>
        {selectedRequest ? <>{selectedRequest.explanation && <div className="decision-explanation"><small>DECISION EXPLANATION</small><p>{selectedRequest.explanation}</p></div>}<div className="detail-summary"><div><small>REQUEST ID</small><strong>{selectedRequest.id}</strong></div><div><small>WORKFLOW</small><strong>{selectedRequest.workflowId} · v{selectedRequest.workflowVersion}</strong></div><div><small>ATTEMPTS</small><strong>{selectedRequest.attempts}</strong></div><div><small>NEXT RETRY</small><strong>{date(selectedRequest.nextRetryAt)}</strong></div></div>
          {selectedRequest.status === 'RETRY_PENDING' && <button className="secondary" disabled={busy} onClick={retry}>Retry now →</button>}
          {selectedRequest.status === 'MANUAL_REVIEW' && <div className="review-box"><h3>Resolve manual review</h3><div className="review-fields"><label>Operator<input value={operator} onChange={(event) => setOperator(event.target.value)} /></label><label>Reason<input value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="Record why you made this decision" /></label></div><div className="review-actions"><button className="secondary" disabled={busy || !operator.trim() || !reviewNote.trim()} onClick={() => resolveReview('APPROVED')}>Approve →</button><button className="reject-button" disabled={busy || !operator.trim() || !reviewNote.trim()} onClick={() => resolveReview('REJECTED')}>Reject →</button></div></div>}
          <div className="audit-heading"><h3>Audit timeline</h3><span>Newest first</span></div><Audit request={selectedRequest} /></> : <p className="empty">Select a request to inspect each stage, rule, data reference, and outcome.</p>}
      </section>
    </main>
    <footer>DECISION / SYSTEM <span>Built for accountable automation</span></footer>
  </div>;
}
