"use client";

import * as React from "react";
import { TextField, TextFieldProps } from "@mui/material";

interface InputProps extends TextFieldProps {
  label: string;
  helperText?: string;
}

export function Input({ label, helperText, ...props }: InputProps) {
  return (
    <TextField
      label={label}
      helperText={helperText}
      variant="outlined"
      fullWidth
      {...props}
    />
  );
}
