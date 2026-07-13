export type FoodSafetyDepartment = {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type FoodSafetyLocationType = "location" | "asset";

export type FoodSafetyLocation = {
  id: string;
  organization_id: string;
  department_id: string | null;
  name: string;
  description: string | null;
  location_type: FoodSafetyLocationType;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type DepartmentInput = {
  name: string;
  description?: string | null;
  active?: boolean;
  sort_order?: number;
};

export type LocationInput = {
  name: string;
  description?: string | null;
  department_id?: string | null;
  location_type?: FoodSafetyLocationType;
  active?: boolean;
  sort_order?: number;
};
