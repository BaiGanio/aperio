window.attachedFiles = [];

const fileInput    = document.getElementById('fileInput');
const attachPreview = document.getElementById('attachPreview');

function updateSendBtn() {
  const hasText  = chatInput.value.trim().length > 0;
  const hasFiles = attachedFiles.length > 0;
  sendBtn.disabled = !(hasText || hasFiles);  // enable if either is true
}

function renderPreviews() {
  attachPreview.innerHTML = '';
  attachedFiles.forEach((file, i) => {
    const chip = document.createElement('div');
    const isImage = file.type.startsWith('image/');
    chip.className = 'attach-chip' + (isImage ? ' is-image' : '');

    if (isImage) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      chip.appendChild(img);
    }

    const name = document.createElement('span');
    name.textContent = file.name;
    chip.appendChild(name);

    const rm = document.createElement('button');
    rm.className = 'remove-file';
    rm.textContent = '×';
    rm.title = 'Remove';
    rm.addEventListener('click', () => {
      attachedFiles.splice(i, 1);
      renderPreviews();
      updateSendBtn();
    });
    chip.appendChild(rm);

    attachPreview.appendChild(chip);
  });
}

document.getElementById('attachBtn').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
  const incoming = Array.from(e.target.files);
  fileInput.value = ''; // reset so same file can be re-added

  // Read each file into a data URL so the message bubble can render thumbnails
  // without a second async read at send time.
  incoming.forEach(file => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      file._dataUrl = ev.target.result; // attach dataUrl directly on the File object
      attachedFiles.push(file);
      renderPreviews();
      updateSendBtn();
    };
    reader.readAsDataURL(file);
  });
});

// hook into your existing input listener — just add updateSendBtn() there
chatInput.addEventListener('input', updateSendBtn);

/**
 * Call this at the start of your send handler (before clearing attachedFiles)
 * to get a plain snapshot for addUserMessage().
 * @returns {{ name: string, type: string, dataUrl: string }[]}
 */
window.getAttachmentsSnapshot = function() {
  return attachedFiles.map(f => ({
    name: f.name,
    type: f.type,
    dataUrl: f._dataUrl || null,
  }));
};