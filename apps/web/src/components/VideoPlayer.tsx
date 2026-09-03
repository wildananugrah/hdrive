import { contentUrl } from "../api/queries";

/**
 * No player library: the API serves Range requests and returns 206, so a plain
 * <video> gets seeking for free.
 *   origin (:3011 vs :5183) and the session is a cookie — without it the
 *   browser sends an anonymous request and the video 401s.
 * - preload="metadata" lets the browser fetch duration via a Range request so
 *   the scrub bar is usable, without pulling the whole file.
 * - The download link deliberately omits ?inline=1 so it gets an `attachment`
 *   Content-Disposition and downloads instead of navigating.
 */
export default function VideoPlayer({ itemId, name }: { itemId: string; name: string }) {
  return (
    <div className="player">
      <video
        data-testid="video"
        src={contentUrl(itemId, { inline: true })}
        crossOrigin="use-credentials"
        controls
        preload="metadata"
        className="player-video"
      />
      <div className="player-bar">
        <span className="player-name">{name}</span>
        <a className="btn" href={contentUrl(itemId)} download={name}>Download</a>
      </div>
    </div>
  );
}
