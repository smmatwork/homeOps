"use client";

import * as React from "react";
import {
  Popover,
  PopoverProps,
  PopoverTrigger,
  PopoverContent,
} from "@mui/material";

interface HoverCardProps extends PopoverProps {
  trigger: React.ReactNode;
  content: React.ReactNode;
}

export function HoverCard({ trigger, content, ...props }: HoverCardProps) {
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);

  const handleOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  return (
    <>
      <PopoverTrigger
        onMouseEnter={handleOpen}
        onMouseLeave={handleClose}
        sx={{ display: "inline-block" }}
      >
        {trigger}
      </PopoverTrigger>
      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={handleClose}
        disableRestoreFocus
        {...props}
      >
        <PopoverContent>{content}</PopoverContent>
      </Popover>
    </>
  );
}
