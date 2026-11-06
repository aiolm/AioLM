//! Native window appearance. Linux owns one GTK-session policy rather than
//! passing System to tao, which turns it into an application Light override.

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowTheme {
    Light,
    Dark,
}

/// GTK's application preference, not an assertion about the effective theme:
/// `None` releases the override so the session's GTK theme remains authoritative.
#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Default)]
pub struct AppearancePolicy {
    selected: Option<WindowTheme>,
    portal: Option<WindowTheme>,
    revision: u64,
}

#[cfg(any(target_os = "linux", test))]
impl AppearancePolicy {
    pub fn select(&mut self, theme: Option<WindowTheme>) {
        self.selected = theme;
        self.revision += 1;
    }

    pub fn observe_portal(&mut self, theme: Option<WindowTheme>) {
        self.portal = theme;
        self.revision += 1;
    }

    /// A read is superseded by a subsequent read, selection, or portal signal.
    pub fn begin_portal_read(&mut self) -> u64 {
        self.revision += 1;
        self.revision
    }

    pub fn finish_portal_read(&mut self, revision: u64, theme: Option<WindowTheme>) -> bool {
        if self.revision != revision {
            return false;
        }
        self.observe_portal(theme);
        true
    }

    pub fn preference(&self) -> Option<bool> {
        self.selected
            .or(self.portal)
            .map(|theme| theme == WindowTheme::Dark)
    }
}

#[cfg(test)]
mod tests {
    use super::{AppearancePolicy, WindowTheme};

    #[test]
    fn system_releases_explicit_override_and_follows_portal_changes() {
        let mut policy = AppearancePolicy::default();
        policy.select(Some(WindowTheme::Light));
        policy.observe_portal(Some(WindowTheme::Dark));
        assert_eq!(policy.preference(), Some(false));
        policy.select(None);
        assert_eq!(policy.preference(), Some(true));
        policy.observe_portal(Some(WindowTheme::Light));
        assert_eq!(policy.preference(), Some(false));
        policy.observe_portal(None);
        assert_eq!(policy.preference(), None);
        policy.select(Some(WindowTheme::Dark));
        policy.observe_portal(Some(WindowTheme::Light));
        assert_eq!(policy.preference(), Some(true));
        policy.observe_portal(None);
        assert_eq!(policy.preference(), Some(true));
        policy.select(None);
        assert_eq!(policy.preference(), None);
    }

    #[test]
    fn late_portal_read_cannot_replace_a_newer_signal_or_mode() {
        let mut policy = AppearancePolicy::default();
        let read = policy.begin_portal_read();
        policy.observe_portal(Some(WindowTheme::Dark));
        assert!(!policy.finish_portal_read(read, Some(WindowTheme::Light)));
        assert_eq!(policy.preference(), Some(true));

        let read = policy.begin_portal_read();
        policy.select(Some(WindowTheme::Light));
        assert!(!policy.finish_portal_read(read, Some(WindowTheme::Dark)));
        assert_eq!(policy.preference(), Some(false));
        policy.select(None);
        assert_eq!(policy.preference(), Some(true));

        let older_read = policy.begin_portal_read();
        let latest_read = policy.begin_portal_read();
        assert!(policy.finish_portal_read(latest_read, Some(WindowTheme::Light)));
        assert!(!policy.finish_portal_read(older_read, Some(WindowTheme::Dark)));
        assert_eq!(policy.preference(), Some(false));
    }
}

#[tauri::command]
pub async fn window_theme(
    window: tauri::WebviewWindow,
    theme: Option<WindowTheme>,
) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    {
        window
            .set_theme(theme.map(|theme| match theme {
                WindowTheme::Light => tauri::Theme::Light,
                WindowTheme::Dark => tauri::Theme::Dark,
            }))
            .map_err(|error| error.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        let (reply, response) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let service = match linux::service() {
                    Ok(service) => service,
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        return;
                    }
                };
                service.select(theme);
                // Manual modes only require GTK, not a working session bus.
                // Any existing portal watch remains attached for later System.
                if theme.is_some() {
                    let _ = reply.send(Ok(()));
                    return;
                }
                gtk::glib::MainContext::default().spawn_local(async move {
                    let result = service.synchronize().await;
                    let _ = reply.send(result);
                });
            })
            .map_err(|error| format!("could not schedule GTK window appearance: {error}"))?;
        response
            .await
            .map_err(|error| format!("GTK window appearance response was dropped: {error}"))?
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{AppearancePolicy, WindowTheme};
    use gio::glib;
    use gio::prelude::*;
    use glib::translate::{from_glib, from_glib_full, ToGlibPtr};
    use glib::variant::ToVariant;
    use gtk::prelude::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use tokio::sync::oneshot;

    const NAMESPACE: &str = "org.freedesktop.appearance";
    const KEY: &str = "color-scheme";
    const GTK_PREFERENCE: &str = "gtk-application-prefer-dark-theme";
    const READ_TIMEOUT_MS: i32 = 5_000;

    type PortalReply = oneshot::Sender<Result<gio::DBusProxy, String>>;

    enum Portal {
        Disconnected,
        Connecting(Vec<PortalReply>),
        Connected(gio::DBusProxy),
    }

    pub(super) struct Service {
        settings: gtk::Settings,
        policy: RefCell<AppearancePolicy>,
        applying: Cell<bool>,
        portal: RefCell<Portal>,
    }

    thread_local! {
        static SERVICE: RefCell<Option<Rc<Service>>> = const { RefCell::new(None) };
    }

    pub(super) fn service() -> Result<Rc<Service>, String> {
        SERVICE.with(|slot| {
            if let Some(service) = slot.borrow().as_ref() {
                return Ok(service.clone());
            }
            let settings = gtk::Settings::default()
                .ok_or_else(|| "GTK has no settings for the current display".to_string())?;
            let service = Rc::new(Service {
                settings,
                policy: RefCell::new(AppearancePolicy::default()),
                applying: Cell::new(false),
                portal: RefCell::new(Portal::Disconnected),
            });
            let weak = Rc::downgrade(&service);
            service
                .settings
                .connect_gtk_application_prefer_dark_theme_notify(move |_| {
                    if let Some(service) = weak.upgrade() {
                        // tao's own portal listener writes this global property even
                        // in explicit mode. Reassert our selected policy in either
                        // ordering of that write and our portal signal.
                        service.apply();
                    }
                });
            *slot.borrow_mut() = Some(service.clone());
            Ok(service)
        })
    }

    impl Service {
        pub(super) fn select(&self, theme: Option<WindowTheme>) {
            self.policy.borrow_mut().select(theme);
            self.apply();
        }

        fn apply(&self) {
            if self.applying.replace(true) {
                return;
            }
            let preference = self.policy.borrow().preference();
            match preference {
                Some(dark) => {
                    if self.settings.is_gtk_application_prefer_dark_theme() != dark {
                        self.settings.set_gtk_application_prefer_dark_theme(dark);
                    }
                }
                // Reset removes the application override; setting false would
                // incorrectly force Light instead of restoring session policy.
                None => self.settings.reset_property(GTK_PREFERENCE),
            }
            self.applying.set(false);
            // WebKit observes GTK normally. In particular, prefer-dark=false
            // does not prove Light: the GTK theme name itself may select Dark.
        }

        fn observe(&self, theme: Option<WindowTheme>) {
            self.policy.borrow_mut().observe_portal(theme);
            self.apply();
        }

        async fn proxy(self: &Rc<Self>) -> Result<gio::DBusProxy, String> {
            let (reply, response) = oneshot::channel();
            {
                let mut portal = self.portal.borrow_mut();
                match &mut *portal {
                    Portal::Connected(proxy) => return Ok(proxy.clone()),
                    Portal::Connecting(waiters) => waiters.push(reply),
                    Portal::Disconnected => {
                        *portal = Portal::Connecting(vec![reply]);
                        let service = self.clone();
                        glib::MainContext::default().spawn_local(async move {
                            let result = gio::DBusProxy::for_bus_future(
                                gio::BusType::Session,
                                // Retain the watch even when no portal exists.
                                // Read may activate it and has a finite timeout.
                                gio::DBusProxyFlags::DO_NOT_LOAD_PROPERTIES
                                    | gio::DBusProxyFlags::DO_NOT_AUTO_START_AT_CONSTRUCTION,
                                None,
                                "org.freedesktop.portal.Desktop",
                                "/org/freedesktop/portal/desktop",
                                "org.freedesktop.portal.Settings",
                            )
                            .await
                            .map_err(|error| {
                                format!("could not connect to the appearance portal: {error}")
                            });
                            if let Ok(proxy) = &result {
                                service.watch(proxy);
                            }
                            let next = match &result {
                                Ok(proxy) => Portal::Connected(proxy.clone()),
                                Err(_) => Portal::Disconnected,
                            };
                            let previous = service.portal.replace(next);
                            if let Portal::Connecting(waiters) = previous {
                                for waiter in waiters {
                                    let _ = waiter.send(result.clone());
                                }
                            }
                        });
                    }
                }
            }
            response
                .await
                .map_err(|error| format!("appearance portal connection was dropped: {error}"))?
        }

        pub(super) async fn synchronize(self: &Rc<Self>) -> Result<(), String> {
            let proxy = self.proxy().await?;
            self.read(&proxy).await
        }

        async fn read(&self, proxy: &gio::DBusProxy) -> Result<(), String> {
            let revision = self.policy.borrow_mut().begin_portal_read();
            let result = proxy
                .call_future(
                    "Read",
                    Some(&(NAMESPACE, KEY).to_variant()),
                    gio::DBusCallFlags::NONE,
                    READ_TIMEOUT_MS,
                )
                .await;
            let theme = match result {
                Ok(reply) => {
                    let (value,) = reply
                        .get::<(glib::Variant,)>()
                        .ok_or_else(|| format!("invalid appearance portal Read reply: {reply}"))?;
                    preference(value)?
                }
                Err(error) if setting_unavailable(&error) => None,
                Err(error) => return Err(format!("could not read the appearance portal: {error}")),
            };
            if self.policy.borrow_mut().finish_portal_read(revision, theme) {
                self.apply();
            }
            Ok(())
        }

        fn watch(self: &Rc<Self>, proxy: &gio::DBusProxy) {
            // Local callbacks allow GTK/Rc state: connect_g_signal requires
            // Send + Sync even though GIO dispatches in the construction context.
            // Install both watches before the first Read can begin.
            let weak = Rc::downgrade(self);
            proxy.connect_local("g-signal", false, move |values| {
                let Some(service) = weak.upgrade() else {
                    return None;
                };
                let result = (|| -> Result<(), String> {
                    let signal = values[2]
                        .get::<String>()
                        .map_err(|error| format!("invalid portal signal name: {error}"))?;
                    if signal != "SettingChanged" {
                        return Ok(());
                    }
                    let parameters = values[3]
                        .get::<glib::Variant>()
                        .map_err(|error| format!("invalid portal signal parameters: {error}"))?;
                    let (namespace, key, value) = parameters
                        .get::<(String, String, glib::Variant)>()
                        .ok_or_else(|| {
                            format!("invalid appearance portal SettingChanged: {parameters}")
                        })?;
                    if namespace == NAMESPACE && key == KEY {
                        service.observe(preference(value)?);
                    }
                    Ok(())
                })();
                if let Err(error) = result {
                    eprintln!("window appearance synchronization failed: {error}");
                }
                None
            });
            let weak = Rc::downgrade(self);
            proxy.connect_local("notify::g-name-owner", false, move |values| {
                let Some(service) = weak.upgrade() else {
                    return None;
                };
                let proxy = match values[0].get::<gio::DBusProxy>() {
                    Ok(proxy) => proxy,
                    Err(error) => {
                        eprintln!("window appearance portal owner notification failed: {error}");
                        return None;
                    }
                };
                // Invalidate reads belonging to the previous portal owner.
                service.observe(None);
                if proxy.connection().is_closed() {
                    eprintln!("window appearance portal session bus connection closed");
                } else if proxy.name_owner().is_some() {
                    glib::MainContext::default().spawn_local(async move {
                        if let Err(error) = service.read(&proxy).await {
                            eprintln!("window appearance synchronization failed: {error}");
                        }
                    });
                }
                None
            });
        }
    }

    fn preference(mut value: glib::Variant) -> Result<Option<WindowTheme>, String> {
        // Legacy Settings.Read returns a doubly boxed value on real portals;
        // SettingChanged uses a single variant. Accept either representation.
        while let Some(inner) = value.as_variant() {
            value = inner;
        }
        match value.get::<u32>() {
            Some(1) => Ok(Some(WindowTheme::Dark)),
            Some(2) => Ok(Some(WindowTheme::Light)),
            Some(_) => Ok(None), // The portal spec defines unknown values as 0.
            None => Err(format!("invalid appearance portal color-scheme: {value}")),
        }
    }

    fn setting_unavailable(error: &glib::Error) -> bool {
        // gio 0.18 has no safe DBusError wrapper. Inspect structured domain,
        // code and remote name rather than matching localized error messages.
        let domain: glib::Quark = unsafe { from_glib(gio::ffi::g_dbus_error_quark()) };
        // SAFETY: Error owns a live, non-null GError for this shared borrow.
        // glib 0.18 exposes domain(), but not a public code() accessor.
        let code = unsafe { (*error.as_ptr()).code };
        if error.domain() == domain
            && matches!(
                code,
                gio::ffi::G_DBUS_ERROR_SERVICE_UNKNOWN
                    | gio::ffi::G_DBUS_ERROR_NAME_HAS_NO_OWNER
                    | gio::ffi::G_DBUS_ERROR_UNKNOWN_INTERFACE
                    | gio::ffi::G_DBUS_ERROR_UNKNOWN_METHOD
            )
        {
            return true;
        }
        // SAFETY: GError is alive for the call; GIO returns a newly allocated
        // nullable string, whose ownership is transferred into GString.
        let remote: Option<glib::GString> = unsafe {
            from_glib_full(gio::ffi::g_dbus_error_get_remote_error(
                error.to_glib_none().0,
            ))
        };
        remote.as_deref() == Some("org.freedesktop.portal.Error.NotFound")
    }
}
