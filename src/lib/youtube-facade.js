// Build the same safe, request-free facade on the server, in articles and in live updates.
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function youtubeVideo(value) {
  if (!value || typeof value.videoId !== 'string' || !/^[-_A-Za-z0-9]{11}$/.test(value.videoId)) return null;
  const title = typeof value.title === 'string' ? value.title.trim().slice(0,200).replace(/[\uD800-\uDBFF]$/,'') : '';
  const startSeconds = Number.isInteger(value.startSeconds) && value.startSeconds >= 0 && value.startSeconds <= 2147483647 ? value.startSeconds : null;
  return { videoId:value.videoId, title, startSeconds };
}

export function youtubeFacade(value,{inline=false}={}) {
  const video = youtubeVideo(value);
  if (!video) return '';
  const {videoId,title,startSeconds} = video;
  const href = `https://www.youtube.com/watch?v=${videoId}${startSeconds === null ? '' : `&t=${startSeconds}s`}`;
  const link = `<a href="${escape(href)}" rel="noopener noreferrer">Watch on YouTube</a>`;
  if (inline) return `<a href="${escape(href)}" rel="noopener noreferrer">Watch on YouTube${title ? `: ${escape(title)}` : ''}</a>`; // Do not put a figure inside a paragraph.
  const label = title || 'YouTube video';
  return `<figure class="youtube-video" data-youtube-video="${videoId}"${startSeconds === null ? '' : ` data-youtube-start="${startSeconds}"`}>
    <div class="youtube-video-screen"><div class="youtube-static"><span class="youtube-video-title">${escape(label)}</span><span>Use the YouTube link below to watch.</span></div><button type="button" class="youtube-play" data-youtube-play aria-label="Play YouTube video: ${escape(label)}"><span class="youtube-play-icon" aria-hidden="true">▶</span><span class="youtube-video-title">${escape(label)}</span><span>Plays from YouTube</span></button></div>
    <figcaption>${link}</figcaption><p class="youtube-status" role="status"></p></figure>`;
}
