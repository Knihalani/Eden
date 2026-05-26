import { NextResponse } from "next/server";
import { api } from "@/lib/api";

interface RouteParams {
  params: Promise<{ job_id: string }>;
}

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { job_id } = await params;
    const data = await api.getJobResult(job_id);
    return NextResponse.json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to get job result";
    return NextResponse.json({ detail: message }, { status: 500 });
  }
}