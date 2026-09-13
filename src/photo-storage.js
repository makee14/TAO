'use strict';
const fs = require('node:fs');
const path = require('node:path');

function getCentralPhotoDir(attachmentsBase, taskId) {
  return path.join(path.resolve(attachmentsBase), taskId);
}

async function saveTaskPhotos({ telegram, taskId, attachmentsDir, fileIds, fetchFn = globalThis.fetch } = {}) {
  if (!fileIds || fileIds.length === 0) return [];
  const centralDir = getCentralPhotoDir(attachmentsDir, taskId);
  fs.mkdirSync(centralDir, { recursive: true });

  const savedPaths = [];

  for (let i = 0; i < fileIds.length; i++) {
    const fileId = fileIds[i];
    const fileName = `photo-${i + 1}.jpg`;
    const centralDest = path.join(centralDir, fileName);

    if (fs.existsSync(fileId)) {
      const buf = fs.readFileSync(fileId);
      fs.writeFileSync(centralDest, buf);
    } else {
      const link = await telegram.getFileLink(fileId);
      const res = await fetchFn(String(link));
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(centralDest, buf);
    }
    savedPaths.push(centralDest);
  }

  return savedPaths;
}

module.exports = {
  getCentralPhotoDir,
  saveTaskPhotos,
};
