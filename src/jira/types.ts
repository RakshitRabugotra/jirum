export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  active?: boolean;
  accountType?: string;
}

export interface IssueType {
  id: string;
  name: string;
  subtask: boolean;
  hierarchyLevel?: number;
  description?: string;
}

export interface Project {
  id: string;
  key: string;
  name: string;
  projectTypeKey?: string;
  style?: string; // "classic" (company-managed) | "next-gen" (team-managed)
  lead?: JiraUser;
  issueTypes?: IssueType[];
  simplified?: boolean;
}

export interface FieldDef {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type: string; items?: string; custom?: string; customId?: number };
  clauseNames?: string[];
}

export interface IssueRef {
  id: string;
  key: string;
  fields?: Record<string, unknown>;
}

export interface Issue {
  id: string;
  key: string;
  self?: string;
  fields: Record<string, unknown> & {
    summary?: string;
    description?: unknown;
    status?: { name: string; statusCategory?: { key: string; name: string } };
    issuetype?: { id: string; name: string; subtask?: boolean };
    priority?: { id: string; name: string };
    assignee?: JiraUser | null;
    reporter?: JiraUser | null;
    labels?: string[];
    created?: string;
    updated?: string;
    duedate?: string | null;
    resolution?: { name: string } | null;
    parent?: IssueRef;
    subtasks?: IssueRef[];
    project?: { id: string; key: string; name: string };
    components?: { id: string; name: string }[];
    fixVersions?: { id: string; name: string }[];
    issuelinks?: IssueLink[];
    comment?: { comments: Comment[]; total: number };
  };
}

export interface IssueLink {
  id: string;
  type: { id: string; name: string; inward: string; outward: string };
  inwardIssue?: IssueRef;
  outwardIssue?: IssueRef;
}

export interface Comment {
  id: string;
  author?: JiraUser;
  body?: unknown;
  created: string;
  updated?: string;
}

export interface Transition {
  id: string;
  name: string;
  to?: { name: string; statusCategory?: { key: string } };
  hasScreen?: boolean;
  fields?: Record<string, { required: boolean; name: string }>;
}

export interface LinkType {
  id: string;
  name: string;
  inward: string;
  outward: string;
}

export interface Board {
  id: number;
  name: string;
  type: string;
  location?: { projectKey?: string; projectName?: string; name?: string };
}

export interface Sprint {
  id: number;
  name: string;
  state: "future" | "active" | "closed";
  startDate?: string;
  endDate?: string;
  goal?: string;
  originBoardId?: number;
}

export interface Page<T> {
  values: T[];
  isLast?: boolean;
  startAt?: number;
  maxResults?: number;
  total?: number;
}
