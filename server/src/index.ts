import "dotenv/config";
import { app } from "./app";
import { supabase } from "./config/supabase";

const port = Number(process.env.PORT ?? 4000);

app.listen(port, () => {
  // Keep a lightweight startup reference to ensure env wiring is loaded.
  void supabase;
  const hasSupabaseUrl = Boolean(process.env.SUPABASE_URL);
  const hasSupabaseServiceRoleKey = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

  console.log(
    `Supabase env loaded: SUPABASE_URL=${hasSupabaseUrl}, SUPABASE_SERVICE_ROLE_KEY=${hasSupabaseServiceRoleKey}`
  );
  console.log(`GrowLink server listening on port ${port}`);
});
