export const stages = [
  "new",
  "qualified",
  "negotiation",
  "payment",
  "won",
  "lost",
] as const;
export type Stage = (typeof stages)[number];
export interface User {
  id: string;
  name: string;
  role: "admin" | "rop" | "manager";
  email: string;
  createdAt: string;
}
export interface Owned {
  id: string;
  ownerId: string;
  createdAt: string;
}
export interface Client extends Owned {
  name: string;
  company: string;
  email: string;
  phone: string;
  city: string;
  stage: Stage;
  source: string;
  notes: string;
}
export interface Deal extends Owned {
  title: string;
  clientId: string;
  amount: number;
  stage: Stage;
}
export interface Task extends Owned {
  title: string;
  clientId: string | null;
  dueDate: string;
  completed: boolean;
}
export interface Entities {
  clients: Client;
  deals: Deal;
  tasks: Task;
}
export type Kind = keyof Entities;

export interface Account extends User { passwordHash: string; }
export interface Session { id: string; userId: string; expiresAt: Date; }
export interface Invite { id: string; email: string | null; role: User["role"]; expiresAt: Date; }
export interface AuthAttempt { id: string; count: number; expiresAt: Date; }
