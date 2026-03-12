"use client";

import * as React from "react";
import { Chip, ChipProps } from "@mui/material";

interface BadgeProps extends ChipProps {
  color?: "default" | "primary" | "secondary" | "error" | "info" | "success" | "warning";
}

export function Badge({ color = "default", ...props }: BadgeProps) {
  return <Chip color={color} {...props} />;
}
