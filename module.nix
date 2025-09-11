{
  config,
  lib,
  ...
}:
with lib; let
  cfg = config.services.paperless-ai;
  stateDir = "/var/lib/paperless-ai";
in {
  options.services.paperless-ai = {
    enable = mkEnableOption "Paperless-AI service";

    package = mkOption {
      type = types.package;
    };

    rag-package = mkOption {
      type = types.package;
    };

    user = mkOption {
      type = types.str;
      default = "paperless-ai";
      description = "User account under which Paperless-AI runs.";
    };

    group = mkOption {
      type = types.str;
      default = "paperless-ai";
      description = "Group account under which Paperless-AI runs.";
    };

    webPort = mkOption {
      type = types.port;
      default = 3000;
      description = "Port for the web service.";
    };

    ragPort = mkOption {
      type = types.port;
      default = 8000;
      description = "Port for the RAG service.";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to open the firewall for Paperless-AI ports.";
    };

    environmentFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = "Environment file containing secrets like API keys.";
    };

    extraEnvironment = mkOption {
      type = types.attrsOf types.str;
      default = {};
      description = "Extra environment variables for Paperless-AI.";
    };
  };

  config = mkIf cfg.enable {
    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.group;
      home = stateDir;
      createHome = true;
    };

    users.groups.${cfg.group} = {};

    networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [
      cfg.webPort
      cfg.ragPort
    ];

    systemd.services.paperless-ai-web = {
      description = "Paperless-AI Web Service";
      wantedBy = ["multi-user.target"];
      after = ["network.target"];

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = stateDir;
        ExecStart = "${cfg.package}/bin/paperless-ai";
        Restart = "always";
        RestartSec = "10";

        # Security settings
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [stateDir];
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
      };

      environment =
        {
          NODE_ENV = "production";
          PORT = toString cfg.webPort;
          RAG_SERVICE_URL = "http://localhost:${toString cfg.ragPort}";
          RAG_SERVICE_ENABLED = "true";
          XDG_DATA_HOME = stateDir;
        }
        // cfg.extraEnvironment;

      serviceConfig.EnvironmentFile = mkIf (cfg.environmentFile != null) cfg.environmentFile;

      preStart = ''
        # Ensure proper permissions
        chmod 755 ${stateDir}
        mkdir -p ${stateDir}/data
        chmod 755 ${stateDir}/data
      '';
    };

    systemd.services.paperless-ai-rag = {
      description = "Paperless-AI RAG Service";
      wantedBy = ["multi-user.target"];
      after = ["network.target"];

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = stateDir;
        ExecStart = "${cfg.rag-package}/bin/paperless-ai-rag";
        Restart = "always";
        RestartSec = "10";

        # Security settings
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [stateDir];
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
      };

      environment =
        {
          PORT = toString cfg.ragPort;
          XDG_DATA_HOME = stateDir;
        }
        // cfg.extraEnvironment;

      serviceConfig.EnvironmentFile = mkIf (cfg.environmentFile != null) cfg.environmentFile;

      preStart = ''
        # Ensure proper permissions
        chmod 755 ${stateDir}
        mkdir -p ${stateDir}/data
        chmod 755 ${stateDir}/data
      '';
    };
  };
}
