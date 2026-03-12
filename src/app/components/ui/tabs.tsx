"use client";

import * as React from "react";
import { Tabs as MuiTabs, Tab, Box, Typography } from "@mui/material";

interface TabItem {
  label: string;
  content: React.ReactNode;
}

interface TabsProps {
  tabs: TabItem[];
  defaultTab?: number;
}

export function Tabs({ tabs, defaultTab = 0 }: TabsProps) {
  const [activeTab, setActiveTab] = React.useState(defaultTab);

  const handleChange = (event: React.SyntheticEvent, newValue: number) => {
    setActiveTab(newValue);
  };

  return (
    <Box>
      <MuiTabs value={activeTab} onChange={handleChange} variant="scrollable" scrollButtons="auto">
        {tabs.map((tab, index) => (
          <Tab key={index} label={tab.label} />
        ))}
      </MuiTabs>
      <Box mt={2}>
        {tabs.map((tab, index) => (
          <Box
            key={index}
            role="tabpanel"
            hidden={activeTab !== index}
            sx={{ display: activeTab === index ? "block" : "none" }}
          >
            {tab.content}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
