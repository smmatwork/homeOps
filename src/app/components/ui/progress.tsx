"use client";

import * as React from "react";
import { Box, LinearProgress, Typography } from "@mui/material";

interface ProgressProps {
  value: number; // Progress value (0-100)
  label?: string; // Optional label to display above the progress bar
}

export function Progress({ value, label }: ProgressProps) {
  return (
    <Box display="flex" flexDirection="column" alignItems="center" gap={1} width="100%">
      {label && (
        <Typography variant="body2" color="textSecondary">
          {label}
        </Typography>
      )}
      <Box width="100%">
        <LinearProgress
          variant="determinate"
          value={value}
          sx={{
            height: 10,
            borderRadius: 5,
            "& .MuiLinearProgress-bar": {
              borderRadius: 5,
            },
          }}
        />
      </Box>
      <Typography variant="caption" color="textSecondary">
        {value}%
      </Typography>
    </Box>
  );
}
