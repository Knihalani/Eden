/**
 * Eden TypeScript SDK — Server-Sent Events streaming.
 */

import { StreamEvent, StreamEventSchema } from "./models";

export class SSEStream {
  private buffer = "";

  constructor(private reader: ReadableStreamDefaultReader<string>) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    while (true) {
      const { value, done } = await this.reader.read();
      if (done) {
        // Flush remaining buffer
        if (this.buffer.trim()) {
          const event = this.parseEvent(this.buffer);
          if (event) yield event;
        }
        break;
      }
      this.buffer += value;

      let idx: number;
      while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
        const raw = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        const event = this.parseEvent(raw);
        if (event) yield event;
      }
    }
  }

  private parseEvent(raw: string): StreamEvent | null {
    const lines = raw.trim().split("\n");
    let eventType = "message";
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (dataLines.length === 0) return null;

    const dataStr = dataLines.join("\n");
    try {
      const data = JSON.parse(dataStr);
      return StreamEventSchema.parse({ event: eventType, data });
    } catch {
      return StreamEventSchema.parse({ event: eventType, data: { text: dataStr } });
    }
  }
}

export async function streamToCompletion(stream: AsyncIterable<StreamEvent>): Promise<Record<string, unknown>> {
  let final: Record<string, unknown> = {};
  for await (const event of stream) {
    if (event.event === "complete") {
      final = event.data;
      break;
    }
  }
  return final;
}
