-- New conflict-region categories (gaza / syria / lebanon) join the breaking
-- set so a Gaza school strike or a Damascus drone raid breaks like a war item
-- does. The update only fires when the stored list is still the ORIGINAL
-- default — an operator who deliberately removed categories keeps their
-- choice. The classifier/AI side lives in the pipeline bundle (no schema
-- change needed for the categories themselves).
update public.settings
set breaking_categories = array['war','iran','proxies','usa','gaza','syria','lebanon']
where breaking_categories = array['war','iran','proxies','usa'];
