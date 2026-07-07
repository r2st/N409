-- Milestone 0, issue #2 — seed the observed role set (features.md §Users).
INSERT INTO roles (key) VALUES
  ('valuation_user'),
  ('admin'),
  ('god'),
  ('supervisor'),
  ('support'),
  ('support_supervisor'),
  ('reviewer'),
  ('main_reviewer'),
  ('contributing_reviewer'),
  ('data'),
  ('data_supervisor'),
  ('partner'),
  ('member'),
  ('investor'),
  ('auto'),
  ('spa'),
  ('ignored')
ON CONFLICT (key) DO NOTHING;
