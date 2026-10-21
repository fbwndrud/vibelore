import {
  assertId,
  assertInteger,
  assertText,
  canonicalDigest,
  canonicalJSON,
  fail,
} from "./contracts.js";
import { validateOriginRef } from "../reuse/bundle.js";

const tables = {
  candidate: "generation_candidates",
  adoption: "asset_adoptions",
  reuseImport: "reuse_imports",
  job: "generation_jobs",
  attempt: "generation_attempts",
};
const eventKinds = new Set([
  "sourcePackage",
  "edition",
  "editionOutput",
  "assetReview",
  "editionReview",
  "editionPublication",
  "cycle",
  "productionCase",
]);
export function nativeRevision(kind, value) {
  return kind === "sourcePackage"
    ? value.sourceDigest
    : kind === "edition"
    ? value.closureDigest
    : kind === "editionOutput" && value.manifestDigest
    ? value.manifestDigest
    : canonicalDigest(value);
}
const refFor = (projectId, kind, value) => ({
  projectId,
  recordKind: kind,
  recordId: value.id,
  revision: nativeRevision(kind, value),
});
// Shared by commands and the bounded read-only owner snapshot. No opening,
// migrations, recovery, or historical HEAD substitution occurs here.
export function cycleNativeRecords(db, projectId) {
  const values = [];
  const add = (kind, id, value, observedAt = null) =>
    values.push({
      ref: { ...refFor(projectId, kind, value), recordId: id },
      value,
      ...(observedAt ? { observedAt } : {}),
    });
  for (const [kind, table] of Object.entries(tables)) {
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table)
    )
      continue;
    for (const row of db
      .prepare(`SELECT id,data_json FROM ${table} WHERE project_id=?`)
      .all(projectId))
      add(kind, row.id, JSON.parse(row.data_json));
  }
  for (const row of db
    .prepare(
      "SELECT aggregate_kind AS kind,aggregate_id AS id,type,value_json FROM events WHERE project_id=? ORDER BY cursor"
    )
    .all(projectId)) {
    const value = JSON.parse(row.value_json);
    if (eventKinds.has(row.kind)) add(row.kind, row.id, value);
    if (
      row.type === "generation.request" &&
      value.intentKey &&
      value.attemptIds
    )
      add("job", value.id, value);
    if (["cycle", "productionCase"].includes(row.kind))
      for (const evidence of value.nativeEvidence ?? []) {
        if (
          ["job", "attempt"].includes(evidence.ref.recordKind) &&
          evidence.ref.projectId === projectId &&
          evidence.ref.revision === canonicalDigest(evidence.value)
        )
          add(
            evidence.ref.recordKind,
            evidence.ref.recordId,
            evidence.value,
            evidence.observedAt
          );
      }
  }
  return [
    ...new Map(values.map((item) => [canonicalJSON(item.ref), item])).values(),
  ];
}
function array(value) {
  if (!Array.isArray(value)) fail("INVALID_INPUT", "Expected a record array.");
}
function localRef(ref, projectId) {
  if (
    !ref ||
    typeof ref !== "object" ||
    Object.keys(ref).sort().join(",") !==
      "projectId,recordId,recordKind,revision"
  )
    fail("INVALID_REFERENCE", "Expected an exact native reference.");
  assertId(ref.projectId);
  assertId(ref.recordKind);
  assertId(ref.recordId);
  assertText(ref.revision);
  if (
    ref.projectId !== projectId ||
    ref.revision.trim().toLowerCase() === "latest"
  )
    fail(
      "INVALID_REFERENCE",
      "Local reference must name an exact current-project version."
    );
}
function referenceValidator(store, projectId) {
  const records = cycleNativeRecords(store.db, projectId),
    nativeEvidence = [];
  function resolve(ref, kinds, external = false) {
    if (ref?.ownerId !== undefined) {
      if (!external)
        fail(
          "INVALID_REFERENCE",
          "External references cannot claim local production or execution."
        );
      validateOriginRef(ref);
      if (kinds && !kinds.includes(ref.recordKind))
        fail("INVALID_REFERENCE", "Reference has the wrong observed meaning.");
      return null;
    }
    localRef(ref, projectId);
    if (kinds && !kinds.includes(ref.recordKind))
      fail("INVALID_REFERENCE", "Reference has the wrong native meaning.");
    const found = records.find(
      (r) => canonicalJSON(r.ref) === canonicalJSON(ref)
    );
    if (!found)
      fail("INVALID_REFERENCE", "Exact native version is not retained.");
    if (
      kinds?.includes("editionOutput") &&
      ref.recordKind === "editionOutput" &&
      (found.value.status !== "completed" ||
        !found.value.manifestDigest ||
        !found.value.manifest?.output?.blobId)
    )
      fail(
        "INVALID_REFERENCE",
        "A render failure or pending receipt is not a produced output."
      );
    if (
      ["job", "attempt"].includes(ref.recordKind) &&
      !nativeEvidence.some((e) => canonicalJSON(e.ref) === canonicalJSON(ref))
    )
      nativeEvidence.push({
        ref,
        value: found.value,
        observedAt: found.observedAt ?? new Date().toISOString(),
      });
    return found.value;
  }
  return { resolve, nativeEvidence };
}
const producedKinds = [
  "candidate",
  "reuseImport",
  "sourcePackage",
  "edition",
  "editionOutput",
];
const decisionKinds = [
  "adoption",
  "assetReview",
  "editionReview",
  "editionPublication",
];
function invalid(message) {
  fail("INVALID_INPUT", message);
}
function fields(value, required, optional = []) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    required.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => ![...required, ...optional].includes(k))
  )
    invalid("Unsupported or missing record field.");
}
function appendOnly(previous, current) {
  if (
    previous &&
    (current.length < previous.length ||
      previous.some((v, i) => canonicalJSON(v) !== canonicalJSON(current[i])))
  )
    invalid("Prior trials and observations are append-only.");
}
function uniqueIds(values) {
  const ids = new Set();
  for (const item of values) {
    assertId(item.id);
    if (ids.has(item.id)) invalid("Duplicate observation or trial ID.");
    ids.add(item.id);
  }
}
function observedExternal(record, ref, inline) {
  if (!ref.ownerId) return;
  const observation =
    inline ??
    record.externalObservations?.find(
      (item) => canonicalJSON(item.ref) === canonicalJSON(ref)
    );
  assertText(observation?.scope);
}
export function registerCycleCommands(service) {
  service.registerCommand("cycle.record", {
    target: ({ envelope }) => ({
      kind: "cycle",
      id: envelope.payload.record?.id,
    }),
    apply({ store, envelope }) {
      const { record, actor, reason } = envelope.payload;
      fields(
        record,
        [
          "id",
          "purpose",
          "previousCycleRefs",
          "inputUses",
          "producedRefs",
          "decisionRefs",
          "outputRefs",
          "executionRefs",
        ],
        ["planning", "externalObservations", "omissions"]
      );
      assertId(record.id);
      assertText(record.purpose);
      assertText(actor);
      assertText(reason);
      const { resolve, nativeEvidence } = referenceValidator(
        store,
        envelope.projectId
      );
      for (const name of [
        "previousCycleRefs",
        "inputUses",
        "producedRefs",
        "decisionRefs",
        "outputRefs",
        "executionRefs",
      ])
        array(record[name]);
      for (const ref of record.previousCycleRefs) {
        resolve(ref, ["cycle"], true);
        observedExternal(record, ref);
      }
      for (const use of record.inputUses) {
        assertText(use.purpose);
        resolve(use.ref, null, true);
        observedExternal(record, use.ref, use.observation);
      }
      for (const ref of record.producedRefs)
        resolve(ref, [
          "candidate",
          "reuseImport",
          "sourcePackage",
          "edition",
          "editionOutput",
        ]);
      for (const ref of record.decisionRefs)
        resolve(ref, [
          "adoption",
          "assetReview",
          "editionReview",
          "editionPublication",
        ]);
      for (const ref of record.outputRefs)
        resolve(ref, ["candidate", "edition", "editionOutput"]);
      for (const ref of record.executionRefs) resolve(ref, ["job", "attempt"]);
      return { ...record, actor, reason, nativeEvidence };
    },
  });
  service.registerCommand("case.record", {
    target: ({ envelope }) => ({
      kind: "productionCase",
      id: envelope.payload.record?.id,
    }),
    apply({ store, envelope, aggregate }) {
      const { record, actor, reason } = envelope.payload;
      fields(
        record,
        [
          "id",
          "question",
          "contextRefs",
          "literalInputRefs",
          "trials",
          "observations",
          "unknowns",
          "classification",
        ],
        [
          "decision",
          "planning",
          "literalInputs",
          "omissions",
          "externalObservations",
        ]
      );
      assertId(record.id);
      assertText(record.question);
      assertText(actor);
      assertText(reason);
      const { resolve, nativeEvidence } = referenceValidator(
        store,
        envelope.projectId
      );
      for (const name of [
        "contextRefs",
        "literalInputRefs",
        "trials",
        "observations",
        "unknowns",
      ])
        array(record[name]);
      for (const ref of [...record.contextRefs, ...record.literalInputRefs]) {
        resolve(ref, null, true);
        observedExternal(record, ref);
      }
      uniqueIds(record.trials);
      uniqueIds(record.observations);
      appendOnly(aggregate.value?.trials, record.trials);
      appendOnly(aggregate.value?.observations, record.observations);
      for (const t of record.trials) {
        fields(
          t,
          [
            "id",
            "kind",
            "status",
            "inputRefs",
            "producedRefs",
            "decisionRefs",
            "outputRefs",
            "executionRefs",
            "conditions",
            "omissions",
          ],
          ["fixtureEvidence", "comparisonUnit"]
        );
        if (
          t.comparisonUnit !== undefined &&
          !["result", "execution"].includes(t.comparisonUnit)
        )
          invalid("Unknown comparison unit.");
        if (
          !["actual", "fixture", "planned"].includes(t.kind) ||
          ![
            "succeeded",
            "failed",
            "outcome_unknown",
            "unobserved",
            "planned",
          ].includes(t.status)
        )
          invalid("Unknown trial kind or result state.");
        for (const name of [
          "inputRefs",
          "producedRefs",
          "decisionRefs",
          "outputRefs",
          "executionRefs",
          "omissions",
        ])
          array(t[name]);
        if (
          t.kind === "planned" &&
          (t.status !== "planned" ||
            [
              ...t.producedRefs,
              ...t.decisionRefs,
              ...t.outputRefs,
              ...t.executionRefs,
            ].length)
        )
          invalid(
            "Plans cannot contain actual outputs, decisions or executions."
          );
        if (t.kind !== "planned" && t.status === "planned")
          invalid("Only planned trials have a planned state.");
        if (t.kind === "fixture" && t.executionRefs.length)
          invalid("Fixture trials cannot claim native executions.");
        for (const ref of t.inputRefs) {
          resolve(ref, null, true);
          observedExternal(record, ref);
        }
        for (const ref of t.producedRefs) resolve(ref, producedKinds);
        for (const ref of t.decisionRefs) resolve(ref, decisionKinds);
        for (const ref of t.outputRefs)
          resolve(ref, ["candidate", "edition", "editionOutput"]);
        const execution = t.executionRefs.map((ref) =>
          resolve(ref, ["job", "attempt"])
        );
        if (t.kind === "actual") {
          if (
            t.status === "succeeded" &&
            (execution.some(
              (e) => !["succeeded", "candidate_ready"].includes(e.status)
            ) ||
              (!execution.length &&
                ![...t.producedRefs, ...t.outputRefs, ...t.decisionRefs]
                  .length))
          )
            invalid(
              "Success requires actual outputs or successful native evidence."
            );
          if (
            t.status === "failed" &&
            (!execution.length ||
              execution.some(
                (e) => !["failed_definite", "quarantined"].includes(e.status)
              ))
          )
            invalid("Failure requires definite native evidence.");
          if (
            t.status === "outcome_unknown" &&
            (!execution.length ||
              !execution.some((e) => e.status === "outcome_unknown"))
          )
            invalid("Unknown outcome requires native unknown evidence.");
        }
      }
      for (const o of record.observations) {
        assertText(o.scope);
        assertText(o.perspective);
        assertText(o.evaluator?.id);
        if (
          !["self", "independent", "unknown"].includes(o.evaluator.relationship)
        )
          invalid("An observation needs its actual evaluator relationship.");
        if (o.evaluator.relationship === "independent") {
          if (o.evaluator.id === actor || o.perspective === "self-review")
            invalid("Self review cannot be independent evaluation.");
          assertText(o.evaluator.basis);
        }
        if (!o.targetRef && !o.targetSha256)
          invalid("Observation needs an exact target.");
        if (o.targetRef) {
          resolve(o.targetRef, null, true);
          observedExternal(record, o.targetRef);
        }
        if (o.targetSha256 && !/^[a-f0-9]{64}$/.test(o.targetSha256))
          invalid("Invalid observed content hash.");
        if (o.score !== undefined && o.score !== null) {
          if (typeof o.score !== "number" || !Number.isFinite(o.score))
            invalid("Unknown scores must stay null.");
          assertText(o.measurement?.method);
          assertText(o.measurement?.unit);
        }
      }
      if (
        ![
          "accepted-example",
          "matched-comparison",
          "failed-trial",
          "unobserved",
        ].includes(record.classification)
      )
        invalid("Unknown case classification.");
      const decision = record.decision
        ? resolve(record.decision.ref, decisionKinds)
        : null;
      if (record.classification === "accepted-example") {
        const accepted =
          decision &&
          (["adopt", "undo", "approve"].includes(
            decision.action ?? decision.decision
          ) ||
            decision.status === "published");
        const selectedKind = decision?.candidateId ? "candidate" : "edition",
          selectedId = decision?.candidateId ?? decision?.editionId;
        const selected = record.trials
          .filter((t) => t.kind === "actual")
          .flatMap((t) => [...t.producedRefs, ...t.outputRefs])
          .some(
            (ref) =>
              ref.recordKind === selectedKind && ref.recordId === selectedId
          );
        if (!accepted || !selectedId || !selected)
          invalid("Accepted example must select the actual trial result.");
      }
      if (
        record.classification === "failed-trial" &&
        !record.trials.some((t) => t.kind === "actual" && t.status === "failed")
      )
        invalid("Failed trial requires observed native failure.");
      if (record.classification === "matched-comparison") {
        const trials = record.trials.filter(
          (t) =>
            t.kind === "actual" && ["succeeded", "failed"].includes(t.status)
        );
        if (trials.length < 2)
          invalid("Matched comparison needs at least two actual trials.");
        const first = trials[0];
        assertText(first.conditions?.task);
        assertInteger(first.conditions?.budgetMicros);
        if (
          trials.some(
            (t) =>
              canonicalJSON(t.conditions) !== canonicalJSON(first.conditions) ||
              canonicalJSON(t.inputRefs) !==
                canonicalJSON(record.literalInputRefs)
          )
        )
          invalid(
            "Matched trials must retain identical selected inputs and conditions."
          );
        const outcomes = trials.map((t) => {
          const unit =
            t.comparisonUnit ??
            (t.executionRefs.length ? "execution" : "result");
          if (unit === "execution") {
            if (!t.executionRefs.length)
              invalid("Execution comparison needs native execution evidence.");
            const ids = t.executionRefs.map((ref) => {
              const native = resolve(ref, ["job", "attempt"]);
              return ref.recordKind === "attempt"
                ? native.id
                : native.currentAttemptId;
            });
            return canonicalJSON(["execution", [...new Set(ids)].sort()]);
          }
          const results = [...t.producedRefs, ...t.outputRefs].map(
            canonicalJSON
          );
          if (!results.length)
            invalid("Result comparison needs actual result references.");
          return canonicalJSON(["result", [...new Set(results)].sort()]);
        });
        if (new Set(outcomes).size !== trials.length)
          invalid(
            "Repeated attachment to one execution or result is not a comparison trial."
          );
      }
      return { ...record, actor, reason, nativeEvidence };
    },
  });
}

// Qualification is confined to native Ref values. Studio never stores a Library
// UUID or treats an external owner as a locally resolved execution authority.
export function portableCycleRecord(value, ownerId, kind) {
  if (["job", "attempt"].includes(kind)) {
    const keys = [
      "id",
      "jobId",
      "status",
      "intentKey",
      "generationInputDigest",
      "requestDigest",
      "attemptIds",
      "currentAttemptId",
      "retryOfAttemptId",
      "executionIntentId",
      "operationId",
      "providerRequestId",
      "validationStatus",
      "outcomeReason",
    ];
    return {
      ...Object.fromEntries(
        keys.filter((k) => value[k] !== undefined).map((k) => [k, value[k]])
      ),
      evidenceScope:
        "Observed native snapshot; not independent proof of provider completion or payment",
      outputs: (value.outputs ?? [])
        .map((output) => ({
          sha256: output.blobId ?? output.id,
          mime: output.mime,
        }))
        .filter((output) => output.sha256),
    };
  }
  function visit(item) {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    if (
      item.projectId &&
      item.recordKind &&
      item.recordId &&
      item.revision &&
      !item.ownerId
    )
      return { ownerId, ...item };
    return Object.fromEntries(
      Object.entries(item)
        .filter(([key]) => key !== "nativeEvidence")
        .map(([key, child]) => [key, visit(child)])
    );
  }
  return visit(value);
}
export function cycleReferences(kind, value) {
  const refs = [];
  const add = (ref, relation) => refs.push({ ref, relation });
  if (kind === "cycle") {
    for (const ref of value.previousCycleRefs) add(ref, "derived-from");
    for (const use of value.inputUses) add(use.ref, "used-in");
    for (const ref of [
      ...value.producedRefs,
      ...value.decisionRefs,
      ...value.outputRefs,
      ...value.executionRefs,
    ])
      add(ref, "observed-in");
  }
  if (kind === "productionCase") {
    for (const ref of value.contextRefs) add(ref, "observed-in");
    for (const ref of value.literalInputRefs) add(ref, "used-in");
    for (const trial of value.trials) {
      for (const ref of trial.inputRefs) add(ref, "used-in");
      for (const ref of [
        ...trial.producedRefs,
        ...trial.decisionRefs,
        ...trial.outputRefs,
        ...trial.executionRefs,
      ])
        add(ref, "observed-in");
    }
    for (const observation of value.observations)
      if (observation.targetRef) add(observation.targetRef, "observed-in");
    if (value.decision) add(value.decision.ref, "observed-in");
  }
  return [...new Map(refs.map((item) => [canonicalJSON(item), item])).values()];
}
