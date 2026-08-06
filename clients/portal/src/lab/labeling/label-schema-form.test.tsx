import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LabelSchemaForm } from "@/lab/labeling/label-schema-form";

describe("LabelSchemaForm", () => {
  it("renders numbered option buttons for an option-shaped schema and calls onChange with the option value", () => {
    const onChange = vi.fn();
    render(
      <LabelSchemaForm
        schema={{ options: ["good", "bad"] }}
        value={null}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /2\s*bad/i }));
    expect(onChange).toHaveBeenCalledWith("bad");
  });

  it("renders a numeric range input for a score schema", () => {
    render(
      <LabelSchemaForm schema={{ type: "score", min: 0, max: 10 }} value={3} onChange={vi.fn()} />,
    );
    const slider = screen.getByRole("slider", { name: /label score/i }) as HTMLInputElement;
    expect(slider.value).toBe("3");
  });

  it("falls back to a freeform textarea for an unstructured schema", () => {
    const onChange = vi.fn();
    render(<LabelSchemaForm schema={{}} value="" onChange={onChange} />);
    const textarea = screen.getByRole("textbox", { name: /label/i });
    fireEvent.change(textarea, { target: { value: "looks fine" } });
    expect(onChange).toHaveBeenCalledWith("looks fine");
  });
});
