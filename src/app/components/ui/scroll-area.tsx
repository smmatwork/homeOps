"use client";

import * as React from "react";
import { Box } from "@mui/material";

interface ScrollAreaProps {
  children: React.ReactNode;
  height?: string | number;
  width?: string | number;
}

export function ScrollArea({ children, height = "100%", width = "100%" }: ScrollAreaProps) {
  return (
    <Box
      sx={{
        overflow: "auto",
        height,
        width,
        borderRadius: 1,
        "&::-webkit-scrollbar": {
          width: 8,
          height: 8,
        },
        "&::-webkit-scrollbar-thumb": {
          backgroundColor: "rgba(0, 0, 0, 0.2)",
          borderRadius: 4,
        },
        "&::-webkit-scrollbar-track": {
          backgroundColor: "rgba(0, 0, 0, 0.1)",
        },
      }}
    >
      {children}
    </Box>
  );
}
