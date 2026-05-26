import { NextResponse } from "next/server";

interface RouteParams {
  params: Promise<{ job_id: string }>;
}

export async function GET(request: Request, { params }: RouteParams) {
  const { job_id } = await params;
  const FASTAPI_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  // Get the cookie from the incoming request and forward it
  const cookieHeader = request.headers.get("cookie") || "";

  try {
    const response = await fetch(`${FASTAPI_URL}/jobs/${job_id}/stream`, {
      headers: {
        Cookie: cookieHeader,
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        { detail: "Failed to connect to stream" },
        { status: response.status }
      );
    }

    // Stream the SSE response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const reader = response.body?.getReader();
        if (!reader) {
          controller.close();
          return;
        }

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              break;
            }
            controller.enqueue(value);
          }
        } catch {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { detail: "Stream connection failed" },
      { status: 500 }
    );
  }
}