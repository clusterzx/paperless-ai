{
  description = "Paperless-AI - AI-powered extension for Paperless-ngx with automatic document classification, smart tagging, and semantic search";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    nixpkgs,
    flake-utils,
    ...
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = nixpkgs.legacyPackages.${system};

      # Python environment with all required packages for RAG service
      pythonEnv = pkgs.python313.withPackages (ps:
        with ps; [
          fastapi # Web framework for RAG API
          uvicorn # ASGI server
          python-dotenv # Environment file loading
          requests # HTTP client
          numpy # Numerical computing
          pytorch # Machine learning framework
          sentence-transformers # Text embeddings
          chromadb # Vector database
          rank-bm25 # BM25 ranking algorithm
          nltk # Natural language processing
          tqdm # Progress bars
          pydantic # Data validation
        ]);

      # Node.js runtime (dependencies managed via npm)
      nodejs = pkgs.nodejs;

      # Main Paperless-AI package built with buildNpmPackage for proper npm dependency management
      paperless-ai = pkgs.buildNpmPackage {
        pname = "paperless-ai";
        version = "1.0.0";

        src = ./.;

        npmDepsHash = "sha256-nAcI3L0fvVI/CdUxWYg8ZiPRDjF7dW+dcIKC3KlHjNQ=";

        nativeBuildInputs = with pkgs; [
          python313
          pythonEnv
          sqlite
        ];

        buildInputs = with pkgs; [
          sqlite
        ];

        # Don't run the default npm build script
        dontNpmBuild = true;

        postInstall = ''
          # Create wrapper scripts that handle the read-only Nix store limitation
          # by copying the application to a writable directory on first run
          mkdir -p $out/bin

          # Web service wrapper (Node.js + Express)
          cat > $out/bin/paperless-ai << EOF
          #!${pkgs.bash}/bin/bash
          export PATH="${nodejs}/bin:${pythonEnv}/bin:\$PATH"
          export NODE_ENV=production

          # Create a writable working directory using XDG Base Directory specification
          WORK_DIR="\''${XDG_DATA_HOME:-\$HOME/.local/share}/paperless-ai"
          mkdir -p "\$WORK_DIR"

          # Copy application files if they don't exist (first run setup)
          if [ ! -f "\$WORK_DIR/server.js" ]; then
            echo "Setting up Paperless-AI in \$WORK_DIR..."
            cp -r $out/lib/node_modules/paperless-ai/* "\$WORK_DIR/"
            chmod -R u+w "\$WORK_DIR"
          fi

          # Ensure data directory exists for SQLite database and config files
          mkdir -p "\$WORK_DIR/data"

          cd "\$WORK_DIR"
          exec ${nodejs}/bin/node server.js "\$@"
          EOF
          chmod +x $out/bin/paperless-ai

          # RAG service wrapper (Python + FastAPI)
          cat > $out/bin/paperless-ai-rag << EOF
          #!${pkgs.bash}/bin/bash
          export PATH="${pythonEnv}/bin:\$PATH"

          # Create a writable working directory using XDG Base Directory specification
          WORK_DIR="\''${XDG_DATA_HOME:-\$HOME/.local/share}/paperless-ai"
          mkdir -p "\$WORK_DIR"

          # Copy application files if they don't exist (first run setup)
          if [ ! -f "\$WORK_DIR/main.py" ]; then
            echo "Setting up Paperless-AI RAG service in \$WORK_DIR..."
            cp -r $out/lib/node_modules/paperless-ai/* "\$WORK_DIR/"
            chmod -R u+w "\$WORK_DIR"
          fi

          # Ensure data directory exists for vector database and embeddings
          mkdir -p "\$WORK_DIR/data"

          cd "\$WORK_DIR"
          exec ${pythonEnv}/bin/python main.py "\$@"
          EOF
          chmod +x $out/bin/paperless-ai-rag
        '';

        meta = with pkgs.lib; {
          description = "AI-powered extension for Paperless-ngx that brings automatic document classification, smart tagging, and semantic search";
          homepage = "https://github.com/clusterzx/paperless-ai";
          license = licenses.mit;
          maintainers = [];
          platforms = platforms.linux ++ platforms.darwin;
        };
      };
      # NixOS service module for production deployment
      # Creates systemd services for both web interface and RAG API
      paperless-ai-service = {
        config,
        lib,
        pkgs,
        ...
      }:
        with lib; let
          cfg = config.services.paperless-ai;
          stateDir = "/var/lib/paperless-ai";
        in {
          options.services.paperless-ai = {
            enable = mkEnableOption "Paperless-AI service";

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
                ExecStart = "${paperless-ai}/bin/paperless-ai";
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
                ExecStart = "${paperless-ai}/bin/paperless-ai-rag";
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
        };
    in {
      # Package outputs
      packages = {
        default = paperless-ai;
        paperless-ai = paperless-ai;
      };

      # NixOS service modules for production deployment
      nixosModules = {
        default = paperless-ai-service;
        paperless-ai = paperless-ai-service;
      };

      # Development environments
      devShells.default = pkgs.mkShell {
        buildInputs = with pkgs; [
          # Node.js development stack
          nodejs
          nodePackages.npm
          nodePackages.nodemon
          nodePackages.eslint
          nodePackages.prettier

          # Python development stack
          pythonEnv
          python313Packages.pip
          python313Packages.black
          python313Packages.flake8
          python313Packages.mypy

          # Database tools
          sqlite

          # Development utilities
          git
          curl
          jq
        ];
      };

      apps = {
        default = {
          type = "app";
          program = "${paperless-ai}/bin/paperless-ai";
        };
        paperless-ai = {
          type = "app";
          program = "${paperless-ai}/bin/paperless-ai";
        };
        rag-service = {
          type = "app";
          program = "${paperless-ai}/bin/paperless-ai-rag";
        };
      };
    });
}
