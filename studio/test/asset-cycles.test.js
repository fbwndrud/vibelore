import test from "node:test";
import assert from "node:assert/strict";
import { withStudio } from "./helpers/project.js";
import {
  assetImport,
  environmentSlot,
  png,
  basePixels,
} from "./helpers/images.js";
import { canonicalDigest } from "../src/engine/contracts.js";
import { createStudioOwnerAdapter } from "../src/source/export-studio-assets.js";

const local = (kind, value, revision = canonicalDigest(value)) => ({
  projectId: "p1",
  recordKind: kind,
  recordId: value.id,
  revision,
});
const cycle = (id, fields = {}) => ({
  id,
  purpose: "Reuse the selected room in the next production",
  previousCycleRefs: [],
  inputUses: [],
  producedRefs: [],
  decisionRefs: [],
  outputRefs: [],
  executionRefs: [],
  ...fields,
});
const record = (f, kind, value, overrides = {}) =>
  f.command(
    kind === "cycle" ? "cycle.record" : "case.record",
    {
      record: value,
      actor: "artist",
      reason: "Record observed work",
      ...overrides.payload,
    },
    { aggregate: { kind, id: value.id }, ...overrides }
  );

test("record actual import, local derivation and adoption, then reference the exact previous cycle with normal replay/CAS", async (t) => {
  const f = await withStudio(t),
    slot = environmentSlot();
  const imported = (await assetImport(f, "source", await png(basePixels), slot))
    .value.candidate;
  await f.command(
    "candidate.adopt",
    {
      slotId: slot.id,
      candidateId: imported.id,
      actor: "artist",
      reason: "Choose room",
    },
    { aggregate: { kind: "assetSlot", id: slot.id } }
  );
  const derived = (
    await f.command(
      "asset.derive",
      {
        id: "crop",
        slotId: slot.id,
        baseCandidateId: imported.id,
        operation: "crop",
        rect: { left: 0, top: 0, width: 2, height: 1 },
        actor: "artist",
      },
      { aggregate: { kind: "assetSlot", id: slot.id } }
    )
  ).value.candidate;
  const state = await f.service.snapshot("p1");
  const first = cycle("first", {
    inputUses: [{ ref: local("candidate", imported), purpose: "crop source" }],
    producedRefs: [local("candidate", derived)],
    decisionRefs: [local("adoption", state.adoptions[0])],
  });
  const saved = await record(f, "cycle", first, { commandId: "record-first" });
  assert.equal(saved.value.actor, "artist");
  const replayed = await record(f, "cycle", first, {
    commandId: "record-first",
    expectedRevision: 0,
  });
  assert.equal(replayed.replayed, true);
  await assert.rejects(record(f, "cycle", first, { expectedRevision: 0 }), {
    code: "REVISION_CONFLICT",
  });
  await record(
    f,
    "cycle",
    cycle("second", { previousCycleRefs: [local("cycle", saved.value)] })
  );
  const after = await f.service.snapshot("p1");
  assert.equal(after.cycles.length, 2);
  assert.deepEqual(after.cycles[0].producedRefs, [local("candidate", derived)]);
  assert.deepEqual(after.jobs, state.jobs);
  assert.deepEqual(after.adoptions, state.adoptions);
  assert.equal(
    (await f.service.history("p1")).entries[0].label,
    "제작 사이클 기록"
  );
});

const productionCase = (id, fields = {}) => ({
  id,
  question: "Which crop fits this single room use?",
  contextRefs: [],
  literalInputRefs: [],
  trials: [],
  observations: [],
  unknowns: ["rights", "quality"],
  classification: "unobserved",
  ...fields,
});
const trial = (id, refs, fields = {}) => ({
  id,
  kind: "actual",
  status: "succeeded",
  inputRefs: [],
  producedRefs: refs,
  decisionRefs: [],
  outputRefs: [],
  executionRefs: [],
  conditions: { task: "room crop", budgetMicros: 0 },
  omissions: ["No audience evaluation"],
  ...fields,
});

test("scoped accepted case retains literal inputs, unknown values and append-only observations with actor/reason history", async (t) => {
  const f = await withStudio(t),
    c = (await assetImport(f, "one", await png(basePixels))).value.candidate;
  await f.command(
    "candidate.adopt",
    {
      slotId: "background",
      candidateId: c.id,
      actor: "artist",
      reason: "Fits this scene",
    },
    { aggregate: { kind: "assetSlot", id: "background" } }
  );
  const adoption = (await f.service.snapshot("p1")).adoptions[0];
  const observation = {
    id: "view1",
    targetRef: local("candidate", c),
    scope: "One selected still image",
    perspective: "self-review",
    evaluator: { id: "artist", relationship: "self" },
    text: "Crop fits the chosen slot",
    score: null,
    rights: "unknown",
  };
  const value = productionCase("room", {
    literalInputRefs: [local("candidate", c)],
    trials: [trial("take1", [local("candidate", c)])],
    observations: [observation],
    decision: { ref: local("adoption", adoption) },
    classification: "accepted-example",
  });
  await record(f, "productionCase", value);
  const updated = {
    ...value,
    observations: [
      ...value.observations,
      {
        ...observation,
        id: "view2",
        scope: "Second local viewing",
        text: "No broader claim",
      },
    ],
  };
  await record(f, "productionCase", updated, {
    payload: {
      record: updated,
      actor: "artist",
      reason: "Append second viewing",
    },
  });
  const state = await f.service.snapshot("p1");
  assert.equal(state.productionCases[0].observations.length, 2);
  assert.equal(state.productionCases[0].observations[0].score, null);
  const events = (await f.service.events("p1")).filter(
    (e) => e.type === "case.record"
  );
  assert.equal(events[0].value.reason, "Record observed work");
  assert.equal(events[1].value.reason, "Append second viewing");
  await assert.rejects(
    record(f, "productionCase", {
      ...updated,
      observations: [{ ...observation, text: "Rewritten past" }],
    }),
    { code: "INVALID_INPUT" }
  );
  await assert.rejects(
    record(f, "productionCase", {
      ...value,
      id: "comparison",
      classification: "matched-comparison",
    }),
    { code: "INVALID_INPUT" }
  );
  await assert.rejects(
    record(f, "productionCase", {
      ...value,
      id: "fake-independent",
      observations: [
        {
          ...observation,
          evaluator: {
            id: "artist",
            relationship: "independent",
            basis: "same host",
          },
        },
      ],
    }),
    { code: "INVALID_INPUT" }
  );
  assert.equal((await f.service.snapshot("p1")).adoptions.length, 1);
});

test("exact local references reject missing versions, wrong meanings and external production; planned and fixture trials cannot invent executions", async (t) => {
  const f = await withStudio(t),
    c = (await assetImport(f, "one", await png(basePixels))).value.candidate;
  for (const fields of [
    {
      producedRefs: [{ ...local("candidate", c), revision: "missing-version" }],
    },
    { producedRefs: [{ ...local("candidate", c), projectId: "other" }] },
    { decisionRefs: [local("candidate", c)] },
    { executionRefs: [local("candidate", c)] },
    { producedRefs: [{ ownerId: "foreign", ...local("candidate", c) }] },
  ])
    await assert.rejects(record(f, "cycle", cycle("invalid", fields)), {
      code: "INVALID_REFERENCE",
    });
  const planned = trial("future", [], { kind: "planned", status: "planned" });
  await record(
    f,
    "productionCase",
    productionCase("plans", {
      trials: [planned],
      planning: { desiredProvider: "future-paid-provider" },
    })
  );
  for (const bad of [
    { ...planned, producedRefs: [local("candidate", c)] },
    { ...planned, status: "succeeded" },
    trial("fixture", [], {
      kind: "fixture",
      executionRefs: [local("candidate", c)],
    }),
  ])
    await assert.rejects(
      record(f, "productionCase", productionCase("bad", { trials: [bad] })),
      { code: "INVALID_INPUT" }
    );
  assert.deepEqual((await f.service.snapshot("p1")).jobs, []);
});

test("registered read-only owner qualifies cycles/cases and exposes external input lineage without adoption or private execution logs", async (t) => {
  const { openLibrary } = await import("../src/library/index.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const f = await withStudio(t),
    directory = await mkdtemp(join(tmpdir(), "cycle-library-"));
  const external = {
    ownerId: "foreign-owner",
    projectId: "foreign-project",
    recordKind: "candidate",
    recordId: "literal-source",
    revision: "exact:1",
  };
  const c = (await assetImport(f, "one", await png(basePixels))).value
    .candidate;
  const first = await record(
    f,
    "cycle",
    cycle("use", {
      inputUses: [
        {
          ref: external,
          purpose: "Observed source only",
          observation: {
            scope:
              "Metadata supplied by artist; no external execution verified",
          },
        },
      ],
      producedRefs: [local("candidate", c)],
    })
  );
  await record(
    f,
    "productionCase",
    productionCase("observed", {
      contextRefs: [local("cycle", first.value)],
      literalInputRefs: [external],
      externalObservations: [
        { ref: external, scope: "Selected literal source citation" },
      ],
      literalInputs: [
        { text: "Use a quiet room", purpose: "Explicit selected prompt" },
      ],
      omissions: ["No external provider request log"],
    })
  );
  const before = await f.service.snapshot("p1");
  const library = await openLibrary({
    directory,
    adapters: { studio: createStudioOwnerAdapter },
  });
  t.after(async () => {
    await library.close();
    await rm(directory, { recursive: true, force: true });
  });
  let serial = 0;
  const command = async (type, payload) =>
    library.command({
      commandId: `lib-${++serial}`,
      expectedRegistryRevision: (await library.query({ type: "find" }))
        .registryRevision,
      type,
      payload,
    });
  const owner = await command("owner.register", {
    adapterKind: "studio",
    locator: { directory: f.directory },
    allowedProjects: ["p1"],
  });
  assert.equal(
    (await command("owner.refresh", { ownerId: owner.ownerId })).status,
    "observed-available"
  );
  const cases = (await library.query({ type: "cases", ownerId: owner.ownerId }))
    .cases;
  assert.equal(cases.length, 1);
  assert.equal(cases[0].literalInputs[0].text, "Use a quiet room");
  assert.equal(cases[0].contextRefs[0].ownerId, owner.ownerId);
  const uses = (await library.query({ type: "uses", ref: external })).uses;
  assert.ok(uses.some((u) => u.usedIn.recordKind === "cycle"));
  assert.ok(uses.some((u) => u.usedIn.recordKind === "productionCase"));
  assert.ok(
    (await library.query({ type: "lineage", ref: external })).links.length >= 2
  );
  const root = (
    await library.query({ type: "find", ownerId: owner.ownerId })
  ).entries.find((e) => e.ref.recordKind === "productionCase").ref;
  const exported = await library.exportExact({
    ownerId: owner.ownerId,
    roots: [root],
    disclosure: { includedScope: "One scoped case", omittedEvidence: [] },
  });
  assert.deepEqual(
    exported.bundle.records.find((r) => r.ref.recordKind === "productionCase")
      .metadata.nativeRecord.literalInputRefs,
    [external]
  );
  assert.deepEqual(
    (await f.service.snapshot("p1")).adoptions,
    before.adoptions
  );
  assert.equal(
    (await f.service.snapshot("p1")).eventCursor,
    before.eventCursor
  );
});

test("job and attempt observations keep exact old versions after native state changes and redact provider requests on export", async (t) => {
  const { withGeneration, generationCommand } = await import(
    "./helpers/project.js"
  );
  const { runWorker } = await import("../src/engine/worker.js");
  const f = await withGeneration(t, {
    providers: {
      fake: {
        capabilities: async () => ({ kinds: ["image"], models: ["fake-v1"] }),
        generate: async () => ({
          outputs: [{ bytes: await png(basePixels), mime: "image/png" }],
        }),
      },
    },
  });
  await generationCommand(f);
  const state = await f.service.snapshot("p1"),
    { reservationStatus, ...attempt } = state.attempts[0];
  const jobRef = local("job", state.jobs[0]),
    attemptRef = local("attempt", attempt);
  await record(
    f,
    "cycle",
    cycle("before", { executionRefs: [jobRef, attemptRef] })
  );
  await runWorker({ service: f.service, drain: true });
  assert.equal(
    (await f.service.snapshot("p1")).jobs[0].status,
    "candidate_ready"
  );
  await record(
    f,
    "cycle",
    cycle("after", { executionRefs: [jobRef, attemptRef] })
  );
  await assert.rejects(
    record(
      f,
      "cycle",
      cycle("missing", {
        executionRefs: [{ ...attemptRef, revision: "unobserved-past" }],
      })
    ),
    { code: "INVALID_REFERENCE" }
  );
  const a = createStudioOwnerAdapter({
    locator: { directory: f.directory },
    ownerId: "observing-owner",
    allowedProjects: ["p1"],
  });
  const old = { ownerId: "observing-owner", ...jobRef },
    captured = await a.capture();
  assert.ok(
    captured.entries.some(
      (e) =>
        e.ref.revision === jobRef.revision && e.ref.recordId === jobRef.recordId
    )
  );
  const data = await a.exportExact({ roots: [old] });
  const native = data.bundle.records[0].metadata.nativeRecord;
  assert.equal(native.status, "queued");
  assert.equal(native.request, undefined);
  assert.equal(JSON.stringify(data).includes("A quiet blue room"), false);
  assert.match(data.bundle.disclosure.omittedEvidence.join(" "), /request/i);
});

test("outcome_unknown remains unknown and cannot become a successful case through recording", async (t) => {
  const { withGeneration, generationCommand } = await import(
    "./helpers/project.js"
  );
  const { runWorker } = await import("../src/engine/worker.js");
  const f = await withGeneration(t, {
    providers: {
      fake: {
        capabilities: async () => ({ kinds: ["image"], models: ["fake-v1"] }),
        generate: async () => ({
          status: "pending",
          operationId: "fake-pending",
        }),
      },
    },
  });
  await generationCommand(f);
  await runWorker({ service: f.service, drain: true });
  const before = await f.service.snapshot("p1"),
    { reservationStatus, ...attempt } = before.attempts[0];
  const unknown = trial("pending", [], {
    status: "outcome_unknown",
    executionRefs: [local("attempt", attempt)],
  });
  await record(
    f,
    "productionCase",
    productionCase("unknown", { trials: [unknown] })
  );
  await assert.rejects(
    record(
      f,
      "productionCase",
      productionCase("false-success", {
        trials: [{ ...unknown, status: "succeeded" }],
      })
    ),
    { code: "INVALID_INPUT" }
  );
  const after = await f.service.snapshot("p1");
  assert.equal(after.attempts[0].status, "outcome_unknown");
  assert.deepEqual(after.reservations, before.reservations);
});

test("matched comparison requires distinct actual results under the same literal inputs and explicit conditions", async (t) => {
  const f = await withStudio(t),
    one = (await assetImport(f, "one", await png(basePixels))).value.candidate;
  const two = (
    await assetImport(
      f,
      "two",
      await png(basePixels.map((v, i) => (i === 0 ? v + 1 : v)))
    )
  ).value.candidate;
  const value = productionCase("matched", {
    classification: "matched-comparison",
    trials: [
      trial("one", [local("candidate", one)]),
      trial("two", [local("candidate", two)]),
    ],
  });
  await record(f, "productionCase", value);
  assert.equal(
    (await f.service.snapshot("p1")).productionCases[0].classification,
    "matched-comparison"
  );
  for (const trials of [
    [
      value.trials[0],
      {
        ...value.trials[1],
        conditions: { task: "different task", budgetMicros: 0 },
      },
    ],
    [
      value.trials[0],
      { ...value.trials[1], producedRefs: [local("candidate", one)] },
    ],
    [value.trials[0], { ...value.trials[1], kind: "fixture" }],
    [
      value.trials[0],
      {
        ...value.trials[1],
        conditions: { task: "room crop", budgetMicros: null },
      },
    ],
  ])
    await assert.rejects(
      record(f, "productionCase", { ...value, id: "not-matched", trials }),
      { code: "INVALID_INPUT" }
    );
  assert.equal((await f.service.snapshot("p1")).productionCases.length, 1);
});

test("a real bundle import receipt and an actual rendered Edition output can anchor the next production cycle", async (t) => {
  const { audioFixture } = await import("./helpers/render-fixture.js");
  const { bundleFixture, ref, pngSha256 } = await import(
    "./helpers/bundles.js"
  );
  const f = await audioFixture(t),
    slot = environmentSlot("reused-room");
  const data = bundleFixture({
    records: [
      {
        ref: ref(),
        metadata: {
          title: "Selected room",
          mediaKind: "image",
          roles: ["environment-reference"],
          subjects: [],
        },
        requiredFileSha256s: [pngSha256],
        sourcePins: {},
        evidenceRefs: [],
      },
    ],
  });
  const intent = {
    target: { kind: "assetSlot", id: slot.id },
    mode: "reuse-preserved",
    purpose: "room source",
    identityMap: [],
    stateMap: [],
    selections: [{ source: ref(), slot, role: "environment-reference" }],
  };
  const inspection = await f.service.inspectReuse({
    projectId: "p1",
    ...data,
    intent,
  });
  const imported = (
    await f.command(
      "asset.importBundle",
      {
        ...data,
        intent,
        inspectionDigest: inspection.inspectionDigest,
        actor: "artist",
        reason: "Reuse selected room",
      },
      { aggregate: intent.target }
    )
  ).value;
  const edition = (
    await f.command(
      "edition.create",
      { id: "edition", productionId: "main", profile: "audio" },
      { aggregate: { kind: "edition", id: "edition" } }
    )
  ).value;
  const output = (
    await f.command(
      "edition.render",
      { editionId: "edition", renderId: "output" },
      { aggregate: { kind: "editionOutput", id: "output" } }
    )
  ).value;
  assert.equal(output.status, "completed");
  await record(
    f,
    "cycle",
    cycle("rendered", {
      inputUses: [
        {
          ref: ref(),
          purpose: "Preserved external input",
          observation: {
            scope: "Exact bundle citation; no inherited adoption",
          },
        },
      ],
      producedRefs: [
        local("reuseImport", imported.importReceipt),
        local("candidate", imported.candidate),
      ],
      outputRefs: [
        local("edition", edition, edition.closureDigest),
        local(
          "editionOutput",
          { ...output, id: "output" },
          output.manifestDigest
        ),
      ],
    })
  );
  await assert.rejects(
    record(
      f,
      "cycle",
      cycle("wrong-output", {
        outputRefs: [
          local("editionOutput", { id: "output" }, edition.closureDigest),
        ],
      })
    ),
    { code: "INVALID_REFERENCE" }
  );
  assert.equal((await f.service.snapshot("p1")).cycles.length, 1);
});

test("accepted classification must select the actual trial result, and cannot accept an unrelated adoption", async (t) => {
  const f = await withStudio(t),
    one = (await assetImport(f, "one", await png(basePixels))).value.candidate;
  const two = (await assetImport(f, "two", await png(basePixels))).value
    .candidate;
  await f.command(
    "candidate.adopt",
    {
      slotId: "background",
      candidateId: two.id,
      actor: "artist",
      reason: "Select second",
    },
    { aggregate: { kind: "assetSlot", id: "background" } }
  );
  const decision = (await f.service.snapshot("p1")).adoptions[0];
  await assert.rejects(
    record(
      f,
      "productionCase",
      productionCase("unrelated", {
        trials: [trial("one", [local("candidate", one)])],
        classification: "accepted-example",
        decision: { ref: local("adoption", decision) },
      })
    ),
    { code: "INVALID_INPUT" }
  );
});

test("one generated job and its attempt aliases cannot masquerade as independent matched trials", async (t) => {
  const { withGeneration, generationCommand } = await import(
    "./helpers/project.js"
  );
  const { runWorker } = await import("../src/engine/worker.js");
  const f = await withGeneration(t, {
    providers: {
      fake: {
        capabilities: async () => ({ kinds: ["image"], models: ["fake-v1"] }),
        generate: async () => ({
          outputs: [{ bytes: await png(basePixels), mime: "image/png" }],
        }),
      },
    },
  });
  await generationCommand(f);
  await runWorker({ service: f.service, drain: true });
  const state = await f.service.snapshot("p1"),
    { reservationStatus, ...attempt } = state.attempts[0];
  const candidate = local("candidate", state.candidates[0]);
  const trials = [
    trial("job-alias", [candidate], {
      executionRefs: [local("job", state.jobs[0])],
    }),
    trial("attempt-alias", [candidate], {
      executionRefs: [local("attempt", attempt)],
    }),
  ];
  await assert.rejects(
    record(
      f,
      "productionCase",
      productionCase("same-execution", {
        classification: "matched-comparison",
        trials,
      })
    ),
    { code: "INVALID_INPUT" }
  );
});

test("a native failed render receipt is context evidence, never an actual produced or successful output", async (t) => {
  const { audioFixture } = await import("./helpers/render-fixture.js");
  const { openStudio } = await import("../src/engine/index.js");
  const f = await audioFixture(t);
  await f.command(
    "edition.create",
    { id: "edition", productionId: "main", profile: "audio" },
    { aggregate: { kind: "edition", id: "edition" } }
  );
  await f.service.close();
  const service = await openStudio({
    directory: f.directory,
    renderer: async () => {
      throw new Error("fixture renderer failure");
    },
  });
  t.after(() => service.close());
  const output = await service.command({
    projectId: "p1",
    commandId: "failed-render",
    aggregate: { kind: "editionOutput", id: "failed-output" },
    expectedRevision: 0,
    type: "edition.render",
    payload: { editionId: "edition", renderId: "failed-output" },
  });
  assert.equal(output.value.status, "failed");
  const ref = local("editionOutput", output.value);
  const command = (kind, value) =>
    service.command({
      projectId: "p1",
      commandId: value.id,
      aggregate: { kind, id: value.id },
      expectedRevision: 0,
      type: kind === "cycle" ? "cycle.record" : "case.record",
      payload: {
        record: value,
        actor: "artist",
        reason: "Record actual failure",
      },
    });
  await command(
    "productionCase",
    productionCase("failure-context", { contextRefs: [ref] })
  );
  await assert.rejects(
    command("cycle", cycle("not-produced", { producedRefs: [ref] })),
    { code: "INVALID_REFERENCE" }
  );
  await assert.rejects(
    command(
      "productionCase",
      productionCase("not-successful", {
        trials: [trial("output", [], { outputRefs: [ref] })],
      })
    ),
    { code: "INVALID_REFERENCE" }
  );
});
