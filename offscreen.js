// Plays the sound background.js names, and answers whether it played.
const SOUNDS = {
  new: 'sounds/new-booking.mp3', // a new booking
  red: 'sounds/red-alert.mp3', // a booking turned red (late)
  cancel: 'sounds/cancelled.mp3', // a booking was cancelled
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'swx:play-chime') return;
  const sound = message.sound in SOUNDS ? message.sound : 'new';
  new Audio(SOUNDS[sound])
    .play()
    .then(() => sendResponse({ ok: true, sound }))
    .catch((error) => sendResponse({ ok: false, sound, error: String(error?.name || error) }));
  return true; // the answer comes asynchronously
});
