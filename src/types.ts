import type Database from "better-sqlite3";

export type AppContext = {
  Variables: {
    userId: string;
  };
};

export type FoodRecord = {
  id: string;
  name: string;
  aliases: string[];
  category: string;
  basis: Record<string, unknown>;
  preferred_value?: Record<string, unknown>;
  notes?: string;
};

export type Dependencies = {
  db: Database.Database;
  close?: () => void;
};
