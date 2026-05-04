// PR H — Minimal SSE frame parser for fetch() + ReadableStream consumption.
// EventSource is GET-only; the analyze-card-dual-images/stream endpoint
// is POST (multipart upload), so the client uses fetch() and parses the
// `data: <json>\n\n` framing manually. Each parsed frame's payload is
// passed back to the caller as a parsed JSON object.
//
// Lines that aren't `data:` (event:, id:, retry:, comments) are ignored
// — the server only emits anonymous data events keyed by a `type` field
// inside the JSON, which is sufficient for the chip-progress flow.

export type SseDataHandler = (payload: any) => void;

export async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onData: SseDataHandler,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separatorIdx: number;
    while ((separatorIdx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, separatorIdx);
      buffer = buffer.slice(separatorIdx + 2);
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      if (dataLines.length === 0) continue;
      const dataStr = dataLines.join("\n");
      try {
        onData(JSON.parse(dataStr));
      } catch (err) {
        console.warn("[sse] failed to parse event JSON:", err, dataStr);
      }
    }
  }
  // Flush any trailing frame the server forgot to terminate.
  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    const dataLines: string[] = [];
    for (const line of buffer.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length > 0) {
      try {
        onData(JSON.parse(dataLines.join("\n")));
      } catch {
        // Silent — incomplete final frame.
      }
    }
  }
}
