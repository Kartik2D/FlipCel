import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAI,
  getGenerativeModel,
  VertexAIBackend,
  ResponseModality,
  type GenerativeModel,
} from "firebase/ai";

// Public web config (not a secret); scoped by Firebase project settings.
const firebaseConfig = {
  apiKey: "AIzaSyAHXTH2j2quu5X-0Vs67Qf3TMEsX-ifpms",
  authDomain: "flipcel-d16b1.firebaseapp.com",
  projectId: "flipcel-d16b1",
  storageBucket: "flipcel-d16b1.firebasestorage.app",
  messagingSenderId: "469826619103",
  appId: "1:469826619103:web:3df780dc62933a636d4b6a",
};

// Nano Banana 2 — see https://firebase.google.com/docs/ai-logic/models
const IMAGE_MODEL = "gemini-3.1-flash-image";

let app: FirebaseApp | null = null;
let model: GenerativeModel | null = null;

function getModel(): GenerativeModel {
  if (model) return model;
  app ??= initializeApp(firebaseConfig);
  // Vertex backend bills through the Firebase/Cloud project (Blaze), not AI Studio credits.
  // "global" — the default us-central1 doesn't serve the Gemini 3 image models.
  const ai = getAI(app, { backend: new VertexAIBackend("global") });
  model = getGenerativeModel(ai, {
    model: IMAGE_MODEL,
    generationConfig: {
      responseModalities: [ResponseModality.TEXT, ResponseModality.IMAGE],
    },
  });
  return model;
}

/**
 * Generate a bitmap from a text prompt and return it as a File so it can go
 * through the normal image → vector import pipeline.
 */
export async function generateImageFile(prompt: string): Promise<File> {
  const text = prompt.trim();
  if (!text) throw new Error("Prompt is empty.");

  const result = await getModel().generateContent(
    `${text}\n\nFlat vector illustration style, bold clean shapes, few solid colors, plain background.`,
  );
  const part = result.response.inlineDataParts()?.[0]?.inlineData;
  if (!part) throw new Error("The model returned no image.");

  const bytes = Uint8Array.from(atob(part.data), (c) => c.charCodeAt(0));
  const ext = part.mimeType.split("/")[1] ?? "png";
  const name =
    text
      .slice(0, 40)
      .replace(/[^\w]+/g, "-")
      .replace(/^-|-$/g, "") || "generated";
  return new File([bytes], `${name}.${ext}`, { type: part.mimeType });
}
