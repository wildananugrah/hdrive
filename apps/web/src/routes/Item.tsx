import { useParams } from "react-router-dom";
import { contentUrl, useItem } from "../api/queries";
import { isNotFound } from "../api/errors";
import { formatBytes } from "../lib/format";
import EmptyState from "../components/EmptyState";
import VideoPlayer from "../components/VideoPlayer";

export default function Item() {
  const { itemId = "" } = useParams();
  const { data: item, isPending, isError, error, refetch } = useItem(itemId);

  // isPending goes false on either success or error, so isError must be
  // checked explicitly — never collapse "error" and "no data yet" together.
  if (isPending) return null;

  if (isError) {
    // 404 covers "no access" as well as "does not exist" — never say
    // "forbidden", that would leak the existence the API hides.
    if (isNotFound(error)) {
      return <EmptyState title="Not found" hint="This file does not exist, or you do not have access." />;
    }
    return (
      <div className="auth-retry" role="alert">
        <EmptyState title="Something went wrong" hint={(error as Error).message} />
        <button type="button" onClick={() => refetch()}>Retry</button>
      </div>
    );
  }

  if (item.status !== "ready") {
    // The API returns 409 for content on a pending item — don't offer a
    // player/download that can only fail.
    return <EmptyState title="Still uploading" hint="This file has not finished uploading yet." />;
  }

  const isVideo = (item.mime ?? "").startsWith("video/");
  return (
    <div className="item-detail">
      <h1>{item.name}</h1>
      <p className="mono-label">{formatBytes(item.size)} · {item.mime ?? "unknown type"}</p>
      {isVideo
        ? <VideoPlayer itemId={item.id} name={item.name} />
        : <a className="btn" href={contentUrl(item.id)} download={item.name}>Download</a>}
    </div>
  );
}
