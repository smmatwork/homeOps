"use client";

import * as React from "react";
import {
  FormControl,
  InputLabel,
  MenuItem,
  Select as MuiSelect,
  SelectProps as MuiSelectProps,
  FormHelperText,
} from "@mui/material";

type SelectProps = MuiSelectProps & {
  label: string;
  options: Array<{ value: string; label: string }>;
  helperText?: string;
  error?: boolean;
};

export function Select({ label, options, helperText, error, ...props }: SelectProps) {
  return (
    <FormControl fullWidth error={error}>
      <InputLabel>{label}</InputLabel>
      <MuiSelect label={label} {...props}>
        {options.map((option, index) => (
          <MenuItem key={index} value={option.value}>
            {option.label}
          </MenuItem>
        ))}
      </MuiSelect>
      {helperText && <FormHelperText>{helperText}</FormHelperText>}
    </FormControl>
  );
}
