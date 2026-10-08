// Local, self-contained diagnostic fixture. These synthetic tones are NOT Korean voices.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { openStudio } from "../src/engine/index.js";
import { startStudioHttp } from "../src/transport/http.js";
const directory = fileURLToPath(new URL("../local-demo/", import.meta.url));
await mkdir(directory, { recursive: true });
const service = await openStudio({
    directory: join(directory, "project"),
    providers: {},
  }),
  projectId = "night-stop";
async function command(type, kind, id, payload) {
  const revision = service.store.aggregate(projectId, { kind, id }).revision;
  return (
    await service.command({
      projectId,
      commandId: randomUUID(),
      aggregate: { kind, id },
      expectedRevision: revision,
      type,
      payload,
    })
  ).value;
}
const cast = [
  ["seoyun", "서윤", "onscreen", "#b98163"],
  ["minjae", "민재", "onscreen", "#718c89"],
  ["eunseo", "은서", "onscreen", "#a695af"],
  ["doyun", "도윤", "onscreen", "#d9b46c"],
  ["narrator", "해설", "narrator", "#fff"],
  ["driver", "버스 기사", "offscreen", "#fff"],
];
const lines = [
  ["narrator", "막차가 끊긴 밤, 네 사람은 같은 정류장에 남았다."],
  ["seoyun", "이 버스, 정말 바다까지 가는 거 맞지?"],
  ["minjae", "표에는 종점 대신 도착하고 싶은 곳을 쓰래."],
  ["eunseo", "그럼 난 오늘 아침으로 갈래. 사과할 사람이 있어."],
  ["doyun", "시간은 안 된대. 장소만 고를 수 있나 봐."],
  ["seoyun", "엄마가 기다리던 항구. 나는 거기로 갈래."],
  ["driver", "마지막 승객 여러분, 목적지를 정하셨습니까?"],
  ["minjae", "한 장에 네 명이 같이 타도 되나요?"],
  ["driver", "돌아올 때도 함께라면 가능합니다."],
  ["eunseo", "그럼 항구로 가자. 사과는 내일 해도 되니까."],
  ["doyun", "좋아. 돌아올 표는 내가 가지고 있을게."],
  ["narrator", "네 사람이 올라타자, 비에 젖은 길 위로 바다가 열렸다."],
];
function tone(index) {
  const rate = 24000,
    frames = rate * 4.5,
    b = Buffer.alloc(44 + frames * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(frames * 2, 40);
  const hz = 330 + index * 55;
  for (let i = 0; i < frames; i++) {
    const env = Math.min(1, i / 120, (frames - i) / 240);
    b.writeInt16LE(
      Math.round(3500 * env * Math.sin((2 * Math.PI * hz * i) / rate)),
      44 + i * 2,
    );
  }
  return b;
}
function person(x, y, color, index, scale = 1) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><ellipse cx="0" cy="212" rx="55" ry="12" fill="#081923" opacity=".6"/><path d="M-31 114 L-25 205 L-6 205 L0 138 L8 205 L29 205 L33 115" fill="#172b38"/><path d="M-25 201 L-35 211 L-5 211 L-5 200 M8 201 L8 211 L41 211 L27 200" fill="#0e202b"/><path d="M-31 32 Q0 19 32 32 L44 124 Q0 139 -44 124Z" fill="${color}"/><path d="M-29 38 L-52 105 L-42 114 L-21 62 M30 38 L51 106 L41 114 L21 62" fill="${color}" stroke="#1c303b" stroke-width="3"/><path d="M-6 30 L-2 121" stroke="#f3d9ad" stroke-opacity=".4" stroke-width="2"/><rect x="-8" y="15" width="17" height="23" rx="6" fill="#d9b59d"/><ellipse cx="1" cy="1" rx="23" ry="30" fill="#e9cbb0"/><path d="M-23 8 Q-36 -38 2 -35 Q35 -30 24 6 L17 -10 Q-4 -4 -18 -14Z" fill="${index === 2 ? "#55434b" : "#26363d"}"/><path d="M-13 2 l5 0 M9 2 l5 0" stroke="#3b4147" stroke-width="2.5"/><path d="M-3 17 Q3 20 8 15" fill="none" stroke="#a37d71" stroke-width="2"/>${index === 0 ? '<path d="M-14 27 Q10 37 24 26 L20 57 L2 49 L-19 49Z" fill="#ddbd84"/>' : ""}${index === 1 ? '<path d="M-20 0 h15 v10 h-15z M5 0 h15 v10 h-15z M-5 4 h10" fill="none" stroke="#566873" stroke-width="2"/>' : ""}${index === 3 ? '<rect x="21" y="80" width="27" height="20" rx="2" fill="#f0d19a" transform="rotate(-15 21 80)"/>' : ""}</g>`;
}
function art(focus) {
  let people = "";
  if (focus < 4)
    people =
      person(800, 375, cast[focus][3], focus, 1.65) +
      person(420, 432, cast[(focus + 1) % 4][3], (focus + 1) % 4, 0.9) +
      person(1130, 435, cast[(focus + 2) % 4][3], (focus + 2) % 4, 0.85);
  else
    people = cast
      .slice(0, 4)
      .map((c, i) => person(535 + i * 170, 435, c[3], i, 1.04))
      .join("");
  const rain = Array.from(
    { length: 75 },
    (_, i) => `<path d="M${(i * 197) % 1600} ${(i * 137) % 870} l-8 25"/>`,
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#102c42"/><stop offset="1" stop-color="#567274"/></linearGradient><linearGradient id="road" x2="0" y2="1"><stop stop-color="#304b53"/><stop offset="1" stop-color="#102b3b"/></linearGradient><radialGradient id="glow"><stop stop-color="#ecc992" stop-opacity=".6"/><stop offset="1" stop-color="#efc886" stop-opacity="0"/></radialGradient><linearGradient id="glass" x2="1" y2="1"><stop stop-color="#90b3b1" stop-opacity=".4"/><stop offset="1" stop-color="#61858c" stop-opacity=".04"/></linearGradient></defs><rect width="1600" height="900" fill="url(#sky)"/><circle cx="1170" cy="165" r="65" fill="#e2d6b0" opacity=".64"/><path d="M0 430V295h90v60h80V230h110v50h100v-60h60v155h100V277h130v122h80v-170h105v75h100v-74h95v125h100v-77h145v90h100v-80h160v140" fill="#203d50"/><g fill="#b7b89a" opacity=".33">${Array.from({ length: 32 }, (_, i) => `<rect x="${i * 51}" y="${300 + (i % 3) * 23}" width="9" height="22"/>`).join("")}</g><rect y="590" width="1600" height="310" fill="url(#road)"/><ellipse cx="790" cy="735" rx="470" ry="92" fill="#b8a680" opacity=".09"/><ellipse cx="750" cy="400" rx="490" ry="420" fill="url(#glow)"/><path d="M330 307 L1190 307 L1250 345 L295 345Z" fill="#112c39"/><path d="M340 324 H1200" stroke="#efd39a" stroke-width="9"/><rect x="353" y="347" width="28" height="300" fill="#1c3542"/><rect x="1155" y="347" width="28" height="300" fill="#1c3542"/><rect x="386" y="360" width="755" height="221" fill="url(#glass)"/><path d="M750 353 V575" stroke="#314b57" stroke-width="9"/><path d="M408 586 H1124 L1117 612 H419Z" fill="#c5ad87"/><path d="M440 611 V653 M1080 611 V650" stroke="#223c46" stroke-width="10"/><rect x="252" y="389" width="13" height="273" fill="#8eada6"/><rect x="220" y="322" width="80" height="89" rx="25" fill="#ddd8ba"/><path d="M235 347 h50 v30 h-50z M241 382 v10 M279 382 v10" stroke="#486768" fill="none" stroke-width="6"/>${people}<g stroke="#b4d2cf" stroke-opacity=".16" stroke-width="2">${rain}</g><g stroke="#a4bcad" stroke-opacity=".22" stroke-width="3"><path d="M190 755 h210 M800 725 h250 M440 810 h420 M1020 842 h290"/></g><path d="M0 887 Q450 820 730 885 T1600 875" fill="none" stroke="#658187" stroke-width="3"/></svg>`;
}
if (process.argv.includes("--setup")) {
  let exists;
  try {
    exists = await service.snapshot(projectId);
  } catch {}
  if (exists) throw Error("Demo already exists; choose render or serve.");
  await command("project.create", "project", projectId, {
    title: "밤의 정류장 · 진단음 데모",
    language: "ko",
    budgetMicros: 0,
  });
  const manuscript = lines
    .map(([id, text]) => `${cast.find((c) => c[0] === id)[1]}: ${text}`)
    .join("\n");
  await command("source.manuscript", "sourcePackage", "source", {
    id: "source",
    title: "밤의 정류장 · 독립 제작 대본",
    language: "ko",
    bytes: [...Buffer.from(manuscript)],
  });
  await command("production.create", "production", "main", {
    id: "main",
    title: "함께 돌아오는 표",
    sourcePackageId: "source",
  });
  for (const [id, name, presence] of cast) {
    await command("cast.put", "cast", id, {
      id,
      name,
      language: "ko",
      characterId: null,
    });
    await command("casting.set", "casting", `voice-${id}`, {
      id: `voice-${id}`,
      scope: "project",
      roleId: id,
      state: null,
      voice: `diagnostic-tone-${id}`,
    });
  }
  const scene = {
    id: "stop",
    title: "막차가 남긴 약속",
    productionId: "main",
    sourcePackageId: "source",
    sourceUnitIds: ["manuscript"],
    occurrences: cast.map(([id, , presence]) => ({
      id: `o-${id}`,
      roleBindingId: id,
      characterId: null,
      presence,
    })),
    presentations: cast.map(([id]) => ({
      occurrenceId: `o-${id}`,
      appearanceStateRef: null,
      castingStateRef: null,
      knowledgeStateRef: null,
    })),
    utterances: lines.map(([id, text], i) => ({
      id: `u${i}`,
      speakerOccurrenceId: `o-${id}`,
      addresseeOccurrenceIds: [],
      text,
      holdMs: 1000,
      acting: { note: "Synthetic diagnostic tone, not a Korean voice" },
    })),
    shots: lines.map(([id], i) => ({
      id: `shot${i}`,
      title: `${i + 1}. ${i === 0 ? "밤의 정류장" : cast.find((c) => c[0] === id)[1]}`,
      intent: i === 0 ? "wide" : id === "driver" ? "insert" : "close",
      transform: {
        x: 0,
        y: 0,
        scale: 1,
        anchor: "center",
        easing: "ease-in-out",
        safeArea: { left: 0.07, top: 0.06, right: 0.07, bottom: 0.08 },
        keyframes: [
          { timeMs: 0, x: 0, y: 0, scale: 1 },
          { timeMs: 5500, x: i % 2 ? 0.02 : -0.02, y: -0.015, scale: 1.06 },
        ],
      },
    })),
  };
  await command("scene.put", "scene", "stop", scene);
  for (let i = 0; i < 6; i++) {
    const slot = {
      id: `image${i}`,
      scope: { kind: "scene", id: "stop" },
      subject: { kind: "environment", id: "night-stop" },
      appearanceStateRef: null,
    };
    const bytes = await sharp(Buffer.from(art(i)))
      .png()
      .toBuffer();
    await writeFile(join(directory, `art-${i}.png`), bytes);
    await command("asset.import", "assetSlot", slot.id, {
      id: `image-candidate${i}`,
      slot,
      mediaKind: "image",
      bytes: [...bytes],
      actor: "local-fixture",
    });
    await command("candidate.adopt", "assetSlot", slot.id, {
      slotId: slot.id,
      candidateId: `image-candidate${i}`,
      actor: "local-fixture",
      reason: "Original local vector illustration rasterized to PNG",
    });
  }
  scene.shots = scene.shots.map((sh, i) => ({
    ...sh,
    referenceSlotId: `image${Math.max(
      0,
      cast.findIndex((c) => c[0] === lines[i][0]),
    )}`,
  }));
  await command("scene.put", "scene", "stop", scene);
  for (const [i, [id]] of lines.entries()) {
    const slot = {
      id: `audio${i}`,
      scope: { kind: "scene", id: "stop" },
      subject: { kind: "role", id },
      appearanceStateRef: null,
      castingStateRef: null,
      utteranceId: `u${i}`,
    };
    const bytes = tone(i);
    await command("asset.import", "assetSlot", slot.id, {
      id: `take${i}`,
      slot,
      mediaKind: "audio",
      bytes: [...bytes],
      actor: "local-fixture",
    });
    await command("candidate.adopt", "assetSlot", slot.id, {
      slotId: slot.id,
      candidateId: `take${i}`,
      actor: "local-fixture",
      reason: "Diagnostic tone only; no spoken-word verification",
    });
  }
  await command("timeline.update", "timeline", "main", {
    productionId: "main",
    fps: 30,
  });
  await command("policy.create", "reviewPolicy", "diagnostic", {
    id: "diagnostic",
    name: "Declared diagnostic fixture: deterministic checks only; no human acting review",
    required: [],
  });
  for (const profile of ["landscape", "portrait", "audio"]) {
    const e = await command("edition.create", "edition", `demo-${profile}`, {
      id: `demo-${profile}`,
      productionId: "main",
      profile,
      policyId: "diagnostic",
    });
    await writeFile(
      join(directory, `${profile}-closure.json`),
      JSON.stringify(e, null, 2),
    );
  }
  await writeFile(
    join(directory, "README.txt"),
    "밤의 정류장 — 66s diagnostic fixture.\n4 on-screen cast + narrator + off-screen driver. Original PNG artwork. Synthetic tones, NOT Korean voices.\nRun node scripts/render-demo.js --serve from studio to replay.\n",
  );
  console.log("Demo created:", directory);
}
if (process.argv.includes("--render")) {
  for (const profile of ["landscape", "portrait", "audio"]) {
    const id = `demo-${profile}`;
    let out = service.store.aggregate(projectId, {
      kind: "editionOutput",
      id,
    }).value;
    if (!out) {
      console.log("Rendering", profile);
      out = await command("edition.render", "editionOutput", id, {
        editionId: id,
        renderId: id,
      });
    }
    if (out.status !== "completed") throw Error(JSON.stringify(out));
    const e = service.store.aggregate(projectId, { kind: "edition", id }).value;
    await writeFile(
      join(directory, `night-stop-${profile}.${out.manifest.output.extension}`),
      await service.readBlob(projectId, out.manifest.output.blobId),
    );
    for (const f of out.manifest.frames)
      await writeFile(
        join(directory, `${profile}-frame-${f.frame}.png`),
        await service.readBlob(projectId, f.blobId),
      );
    await writeFile(
      join(directory, `${profile}-manifest.json`),
      JSON.stringify(out, null, 2),
    );
    if (
      !service.store.aggregate(projectId, { kind: "editionReview", id })
        .revision
    )
      await command("edition.review", "editionReview", id, {
        id,
        editionId: id,
        renderId: id,
        actor: "declared-diagnostic-policy",
        checks: {},
        closureDigest: e.closureDigest,
        outputManifestDigest: out.manifestDigest,
        policyBindingRevision: 0,
      });
    console.log("Checked", profile, out.manifest.durationSeconds);
  }
}
if (process.argv.includes("--serve")) {
  const app = await startStudioHttp({ service, projectId, port: 0 });
  console.log("Demo Studio:", app.url);
  process.once("SIGINT", async () => {
    await app.close();
    await service.close();
  });
} else await service.close();
