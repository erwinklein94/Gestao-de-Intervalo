-- Cria os perfis de SUPERESTRUTURA (Gerente Executivo, Gerentes, Coordenadores
-- e Especialistas) com conta Auth, hierarquia e vinculo gerente <-> operador.
-- Reexecutavel: nao recria contas existentes nem duplica vinculos.

do $$
declare
  rec record;
  v_uid uuid;
begin
  drop table if exists _roster;
  create temporary table _roster (email text, full_name text, role text, manager_email text, ord int);

  insert into _roster (email, full_name, role, manager_email, ord) values
    ('bruno.morais@rumolog.com','Bruno Morais','executive_manager',null,1),
    ('herbert.augusto@rumolog.com','Herbert Augusto','manager','bruno.morais@rumolog.com',2),
    ('rafael.milanez@rumolog.com','Rafael Milanez','manager','bruno.morais@rumolog.com',2),
    ('rodrigo.taflick@rumolog.com','Rodrigo Taflick','manager','bruno.morais@rumolog.com',2),
    ('moises.paiva@rumolog.com','Moises Paiva','coordinator','herbert.augusto@rumolog.com',3),
    ('vanderlei.lima@rumolog.com','Vanderlei Lima','coordinator','herbert.augusto@rumolog.com',3),
    ('maicon.rossini@rumolog.com','Maicon Rossini','coordinator','herbert.augusto@rumolog.com',3),
    ('romulo.rodrigues@rumolog.com','Romulo Rodrigues','specialist','herbert.augusto@rumolog.com',3),
    ('luiz.col@rumolog.com','Luiz Col','coordinator','rafael.milanez@rumolog.com',3),
    ('wesley.brandao@rumolog.com','Wesley Brandao','specialist','rafael.milanez@rumolog.com',3),
    ('carlos.ribeiro@rumolog.com','Carlos Ribeiro','coordinator','rafael.milanez@rumolog.com',3),
    ('ronaldo.conceicao@rumolog.com','Ronaldo Conceicao','coordinator','rafael.milanez@rumolog.com',3),
    ('raifran.rodrigues@rumolog.com','Raifran Rodrigues','specialist','rafael.milanez@rumolog.com',3),
    ('joao.chapina@rumolog.com','Joao Chapina','specialist','rafael.milanez@rumolog.com',3),
    ('israel.barros@rumolog.com','Israel Barros','coordinator','rodrigo.taflick@rumolog.com',3),
    ('luciano.junior@rumolog.com','Luciano Junior','specialist','rodrigo.taflick@rumolog.com',3),
    ('paulo.conceicao@rumolog.com','Paulo Conceicao','coordinator','rodrigo.taflick@rumolog.com',3),
    ('adriano.lima1@rumolog.com','Adriano Lima','coordinator','rodrigo.taflick@rumolog.com',3);

  -- Conta Auth e identidade de e-mail apenas para quem ainda nao existe.
  for rec in select * from _roster order by ord, email loop
    if not exists (select 1 from auth.users u where lower(u.email) = rec.email) then
      v_uid := gen_random_uuid();
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at
      ) values (
        '00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated',
        rec.email, extensions.crypt('Rumo@123', extensions.gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('full_name', rec.full_name), now(), now()
      );
      insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
      values (
        v_uid::text, v_uid,
        jsonb_build_object('sub', v_uid::text, 'email', rec.email, 'email_verified', false, 'phone_verified', false),
        'email', now(), now()
      );
    end if;
  end loop;

  -- Perfis na ordem hierarquica: o gestor precisa existir habilitado antes do subordinado.
  for rec in select * from _roster order by ord, email loop
    update public.user_profiles p set
      full_name = rec.full_name,
      role = rec.role,
      enabled = true,
      profile_needs_review = false,
      coordinator_type = 'superstructure',
      manager_id = (select m.id from public.user_profiles m where m.email = rec.manager_email)
    where p.email = rec.email;
  end loop;

  insert into public.manager_operator_assignments (dataset_id, manager_member_id, operator_member_id)
  select private.real_dataset_id(), mgr.organization_member_id, op.organization_member_id
  from _roster ros
  join public.user_profiles op on op.email = ros.email
  join public.user_profiles mgr on mgr.email = ros.manager_email
  where ros.role in ('coordinator','specialist')
  on conflict do nothing;

  drop table _roster;
end $$;
