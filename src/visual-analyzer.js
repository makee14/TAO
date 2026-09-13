'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ANALYSIS_PROMPT = `You are a UI/UX and web design visual analysis assistant.
Analyze this user-provided mockup or reference screenshot in deep detail so a software engineer can accurately implement it in code.

Provide a comprehensive, structured visual specification covering:
1. OVERALL LAYOUT & STRUCTURE: Page hierarchy, header/navigation, hero section, columns, grids, cards, footer, mobile/desktop responsiveness hints.
2. COLOR PALETTE & THEMES: Background colors (exact hex or dominant tones), accent colors, gradients, surface colors, text colors, dark/light theme.
3. TYPOGRAPHY: Heading hierarchy, font weights, alignments, label styles.
4. COMPONENTS & CONTENT: Transcribe all visible text, headlines, button labels, badges, inputs, icons, and image placements.
5. VISUAL EFFECTS & STYLING: Border radiuses, drop shadows, glow effects, borders, animations or interactive indicators.

Be specific and factual. If certain text or details are visible, quote them directly.`;

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

async function analyzePhoto(photoPath, { apiKey = process.env.GEMINI_API_KEY, fetchFn = globalThis.fetch, model = 'gemini-3.6-flash' } = {}) {
  if (!apiKey || !apiKey.trim() || !fs.existsSync(photoPath)) return '';
  try {
    const fileBytes = fs.readFileSync(photoPath);
    const base64Data = fileBytes.toString('base64');
    const mimeType = getMimeType(photoPath);

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
    const payload = {
      contents: [{
        parts: [
          { text: ANALYSIS_PROMPT },
          { inlineData: { mimeType, data: base64Data } },
        ],
      }],
    };

    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) return '';
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return typeof text === 'string' ? text.trim() : '';
  } catch {
    return '';
  }
}

async function describeTaskPhotos(photoPaths, options = {}) {
  if (!Array.isArray(photoPaths) || photoPaths.length === 0) return '';
  // Parallel: each photo is an independent 5-30s Gemini call, and this whole
  // step blocks the agent spawn on task start. Promise.all preserves order,
  // so the sections still read Photo 1, Photo 2, …
  const specs = await Promise.all(photoPaths.map(p => analyzePhoto(p, options)));
  const sections = [];
  for (let i = 0; i < photoPaths.length; i++) {
    const spec = specs[i];
    if (!spec) continue;
    const title = photoPaths.length > 1 ? `[Visual Reference Analysis for Photo ${i + 1} (${path.basename(photoPaths[i])})]` : `[Visual Reference Analysis (${path.basename(photoPaths[i])})]`;
    sections.push(`${title}\n${spec}`);
  }
  return sections.join('\n\n');
}

module.exports = {
  analyzePhoto,
  describeTaskPhotos,
};
