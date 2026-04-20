"use client";

import * as React from "react";
import { Box, TextField } from "@mui/material";

interface OtpInputProps {
  length: number;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function OtpInput({ length, value, onChange, disabled }: OtpInputProps) {
  const handleChange = (index: number, char: string) => {
    const newValue = value.split("");
    newValue[index] = char;
    onChange(newValue.join(""));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>, index: number) => {
    if (event.key === "Backspace" && !value[index] && index > 0) {
      handleChange(index - 1, "");
    }
  };

  const handleFocus = (event: React.FocusEvent<HTMLElement>, index: number) => {
    if (value[index] !== "") return;
    const t = event.target;
    if (t && typeof (t as any).select === "function") {
      (t as any).select();
    }
  };

  return (
    <Box display="flex" gap={1}>
      {Array.from({ length }).map((_, index) => (
        <TextField
          key={index}
          value={value[index] || ""}
          onChange={(e) => handleChange(index, e.target.value.slice(-1))}
          onKeyDown={(e) => handleKeyDown(e, index)}
          onFocus={(e) => handleFocus(e, index)}
          inputProps={{
            maxLength: 1,
            style: { textAlign: "center" },
          }}
          disabled={disabled}
          sx={{
            width: 48,
            height: 48,
            "& .MuiInputBase-root": {
              textAlign: "center",
            },
          }}
        />
      ))}
    </Box>
  );
}
