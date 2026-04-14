let attachedFiles = [];

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

// document.getElementById('attachBtn').addEventListener('click', () => fileInput.click());

// fileInput.addEventListener('change', (e) => {
//   attachedFiles.push(...Array.from(e.target.files));
//   fileInput.value = ''; // reset so same file can be re-added
//   renderPreviews();
//   updateSendBtn();
// });

// hook into your existing input listener — just add updateSendBtn() there
chatInput.addEventListener('input', updateSendBtn);