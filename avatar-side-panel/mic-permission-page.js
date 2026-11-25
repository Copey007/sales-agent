const status = document.getElementById('status');
const btn = document.getElementById('allow');

function setStatus(text, kind) {
  status.textContent = text;
  status.dataset.kind = kind || '';
}

async function requestMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach((t) => t.stop());
    setStatus('Microphone allowed. You can close this tab and press Start in the A-Gent panel.', 'ok');
  } catch (err) {
    setStatus('The microphone was not allowed. Check the site permissions for this extension and try again.', 'bad');
  }
}

btn.addEventListener('click', requestMic);
