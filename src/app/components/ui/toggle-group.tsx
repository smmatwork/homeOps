"use client";

import * as React from "react";
import { ToggleButton, ToggleButtonGroup, ToggleButtonGroupProps } from "@mui/material";

interface ToggleGroupProps extends ToggleButtonGroupProps {
  options: Array<{ value: string; label: string }>;
  size?: "small" | "medium" | "large";
  exclusive?: boolean;
}

export function ToggleGroup({
  options,
  value,
  onChange,
  size = "medium",
  exclusive = true,
  ...props
}: ToggleGroupProps) {
  return (
    <ToggleButtonGroup
      value={value}
      onChange={onChange}
      exclusive={exclusive}
      size={size}
      {...props}
    >
      {options.map((option) => (
        <ToggleButton key={option.value} value={option.value}>
          {option.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
