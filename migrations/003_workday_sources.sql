-- Workday boards as a source type (Razer, Micron, NVIDIA, DBS, Deutsche Bank, Zebra, Marvell).
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_type_check;
ALTER TABLE sources ADD CONSTRAINT sources_type_check
  CHECK (type IN ('greenhouse','lever','ashby','smartrecruiters','workday','mcf','freehire','mdlist','crawl'));
