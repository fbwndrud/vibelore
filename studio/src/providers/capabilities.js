export const surface = "google-developer-interactions-v1beta";
export const models = Object.freeze({
  image: [
    "gemini-nano-banana-2.1",
    "gemini-3.1-flash-image",
    "gemini-3-pro-image",
  ],
  audio: ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"],
  text: ["gemini-3.8-flash"],
});
export const voices = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
];
export function googleCapabilities(configured) {
  return {
    provider: "google",
    surface,
    available: configured,
    reason: configured
      ? "Account access and quota are checked only by an actual request."
      : "Google API key is not configured. Manual imports remain available.",
    kinds: Object.keys(models),
    models: Object.values(models).flat(),
    catalog: models,
    voices,
    inspect: configured,
    nativeMask: false,
    returnedVoiceVerification: false,
  };
}
