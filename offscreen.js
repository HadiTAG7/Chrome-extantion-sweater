// Plays sounds/new-booking.mp3 when background.js asks, and answers whether it played.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'swx:play-chime') return;
  new Audio('sounds/new-booking.mp3')
    .play()
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.name || error) }));
  return true; // the answer comes asynchronously
});
