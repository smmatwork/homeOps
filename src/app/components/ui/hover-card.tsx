"use client";

import * as React from "react";
import { Box, Popover } from "@mui/material";

type HoverCardProps = {
  trigger: React.ReactNode;
  content: React.ReactNode;
};

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
      <Box
        onMouseEnter={handleOpen}
        onMouseLeave={handleClose}
        sx={{ display: "inline-block" }}
      >
        {trigger}
      </Box>
      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={handleClose}
        disableRestoreFocus
      >
        <Box p={1.5}>{content}</Box>
      </Popover>
    </>
  );
}
