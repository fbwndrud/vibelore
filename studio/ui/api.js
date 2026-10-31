export function revision(snapshot, kind, id) {
  return (
    snapshot?.aggregates.find((a) => a.kind === kind && a.id === id)
      ?.revision ?? 0
  );
}
export function command(
  snapshot,
  type,
  kind,
  id,
  payload,
  expectedRevision = revision(snapshot, kind, id),
) {
  return {
    projectId: snapshot?.project.id ?? "p1",
    commandId: crypto.randomUUID(),
    aggregate: { kind, id },
    expectedRevision,
    type,
    payload,
  };
}
export function utteranceCommand(
  snapshot,
  id,
  patch,
  expectedRevision = revision(snapshot, "utterance", id),
) {
  return command(
    snapshot,
    "utterance.update",
    "utterance",
    id,
    { id, ...patch },
    expectedRevision,
  );
}
export class Drafts {
  constructor() {
    this.items = new Map();
  }
  set(key, value, revision) {
    const old = this.items.get(key);
    this.items.set(key, { value, revision: old?.revision ?? revision });
  }
  get(key) {
    return this.items.get(key);
  }
  delete(key) {
    this.items.delete(key);
  }
}
export class StudioAPI {
  constructor({ baseURL = "", fetchImpl = (...args) => fetch(...args) } = {}) {
    this.baseURL = baseURL;
    this.fetch = fetchImpl;
    this.token = null;
    this.projectId = "p1";
  }
  async request(path, options = {}) {
    const response = await this.fetch(`${this.baseURL}${path}`, {
      ...options,
      headers: {
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...options.headers,
      },
    });
    if (!response.ok) {
      let data;
      try {
        data = await response.json();
      } catch {}
      const e = new Error(data?.error?.code ?? `HTTP_${response.status}`);
      e.code = data?.error?.code ?? `HTTP_${response.status}`;
      throw e;
    }
    return response;
  }
  async connect() {
    this.bootstrap = await (await this.request("/api/bootstrap")).json();
    this.token = this.bootstrap.token;
    this.projectId = this.bootstrap.projectId;
    return this.bootstrap;
  }
  async snapshot() {
    return (
      await this.request(
        `/api/snapshot?projectId=${encodeURIComponent(this.projectId)}`,
      )
    ).json();
  }
  async history(before) {
    const params = new URLSearchParams({ projectId: this.projectId, limit: '50' });
    if (before != null) params.set('before', String(before));
    return (await this.request(`/api/history?${params}`)).json();
  }
  async command(envelope) {
    const body = JSON.stringify({ ...envelope, projectId: this.projectId });
    const large = [
      "source.import",
      "source.manuscript",
      "asset.import",
      "asset.derive",
      "source.importBundle",
      "asset.importBundle",
    ].includes(envelope.type);
    if (
      new TextEncoder().encode(body).length >
      (large ? 128 : 1) * 1024 * 1024
    ) {
      const e = new Error("Encoded import exceeds the transport limit.");
      e.code = "BODY_TOO_LARGE";
      throw e;
    }
    return (
      await this.request(large ? "/api/import" : "/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      })
    ).json();
  }
  async post(path, value) {
    return (await this.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)})).json();
  }
  libraryCommand(envelope) { return this.post('/api/library/commands',envelope); }
  libraryQuery(request) { return this.post('/api/library/query',request); }
  libraryExport(request) { return this.post('/api/library/export',request); }
  inspectReuse(request) { return this.post('/api/reuse/inspect',{...request,projectId:this.projectId}); }
  async blob(candidate) {
    const response = await this.request(
      `/api/blobs/${candidate.blobId}?projectId=${encodeURIComponent(this.projectId)}`,
    );
    return URL.createObjectURL(
      new Blob([await response.arrayBuffer()], { type: candidate.mime }),
    );
  }
  async events(after, signal, onEvent) {
    const response = await this.request(
      `/api/events?projectId=${encodeURIComponent(this.projectId)}&after=${after}`,
      { signal },
    );
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const line = frame.split("\n").find((x) => x.startsWith("data: "));
          if (line) await onEvent(JSON.parse(line.slice(6)));
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
