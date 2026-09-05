import { ImageResponse } from "next/og";

export const alt = "Eden — Making your agent do less work.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: "linear-gradient(160deg, #23222c 0%, #1b1a23 55%, #161519 100%)",
          color: "#ecEBf2",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 54,
              height: 54,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#e8354f",
              color: "#1d0d12",
              fontSize: 40,
              fontWeight: 700,
              clipPath:
                "polygon(25% 3%, 75% 3%, 100% 50%, 75% 97%, 25% 97%, 0% 50%)",
            }}
          >
            e
          </div>
          <div style={{ fontSize: 34, fontWeight: 600, letterSpacing: -1 }}>Eden</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              fontSize: 76,
              lineHeight: 1.15,
              letterSpacing: -2,
              maxWidth: 880,
              display: "flex",
            }}
          >
            Making your agent do less work.
          </div>
          <div style={{ fontSize: 30, color: "#b9b7c6", maxWidth: 800, display: "flex" }}>
            Eden sits beside the agent you already run.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "14px 28px",
              background: "#e8354f",
              color: "#1d0d12",
              fontSize: 26,
              fontWeight: 600,
              borderRadius: 4,
            }}
          >
            Sign up
          </div>
          <div style={{ fontSize: 26, color: "#b9b7c6" }}>Nothing goes live until you Approve.</div>
        </div>
      </div>
    ),
    size,
  );
}
