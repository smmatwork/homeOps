"use client";

import * as React from "react";
import {
  FormControl,
  FormControlLabel,
  Radio,
  RadioGroup as MuiRadioGroup,
  FormLabel,
} from "@mui/material";

interface RadioGroupProps {
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}

export function RadioGroup({ label, options, value, onChange }: RadioGroupProps) {
  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    onChange(event.target.value);
  };

  return (
    <FormControl>
      <FormLabel>{label}</FormLabel>
      <MuiRadioGroup value={value} onChange={handleChange}>
        {options.map((option, index) => (
          <FormControlLabel
            key={index}
            value={option.value}
            control={<Radio />}
            label={option.label}
          />
        ))}
      </MuiRadioGroup>
    </FormControl>
  );
}
