"use client";

import * as React from "react";
import { Box, BoxProps } from "@mui/material";

interface AspectRatioProps extends BoxProps {
  ratio: number; // Aspect ratio as width/height (e.g., 16/9)
}

export function AspectRatio({ ratio, children, sx, ...props }: AspectRatioProps) {
  return (
    <Box
      sx={{
        position: "relative",
        width: "100%",
        paddingTop: `${100 / ratio}%`,
        ...sx,
      }}
      {...props}
    >
      <Box
        sx={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
        }}
      >
        {children}
      </Box>
    </Box>
  );
}
